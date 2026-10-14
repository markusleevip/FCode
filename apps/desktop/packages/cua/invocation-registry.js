import { CUA_LIMITS, CUA_OFFICIAL_PLUGIN_ID, CuaControlError, assertString } from "./control-contract.js";

const MAX_RECORDS = 512;

/** Trusted UI/Host entry points only. This object is never exported to a model Worker. */
export class CuaInvocationRegistry {
  #ports;
  #intents = new Map();
  #pending = new Map();
  #turns = new Map();
  #scheduledCalls = new Map();
  #calls = new Map();
  #sequences = new Map();

  constructor(ports) { this.#ports = ports; }

  prepareIntent(input) {
    for (const key of ["ownerId", "workspaceKey", "commandId", "pluginId"]) assertString(input[key], 512);
    if (input.pluginId !== CUA_OFFICIAL_PLUGIN_ID) throw new CuaControlError("not_authorized");
    if (input.sessionId !== null) assertString(input.sessionId, 256);
    this.#expire();
    if (this.#intents.size >= MAX_RECORDS) throw new CuaControlError("resource_limit");
    const token = this.#ports.createId();
    this.#intents.set(token, { ...input, expiresAt: this.#ports.now() + CUA_LIMITS.callTtlMs });
    return token;
  }

  consumeIntent(input) {
    this.#expire();
    const intent = this.#intents.get(input.token);
    // Delete before verification: a failed or cross-owner attempt cannot leave a replayable token.
    this.#intents.delete(input.token);
    if (!intent || intent.ownerId !== input.ownerId || intent.workspaceKey !== input.workspaceKey ||
        intent.commandId !== input.commandId || intent.sessionId !== input.sessionId) {
      throw new CuaControlError("not_authorized", "Computer Use selection is stale or mismatched.");
    }
    assertString(input.hostId, 256);
    const key = this.#pendingKey(input);
    if (this.#pending.has(key) || this.#pending.size >= MAX_RECORDS) throw new CuaControlError("resource_limit");
    this.#pending.set(key, { ...intent, hostId: input.hostId, generation: this.#ports.createId() });
  }

  acceptEvent(scope, event) {
    this.#expire();
    const stream = JSON.stringify([scope.ownerId, scope.hostId, scope.workspaceKey, event.sessionId]);
    const previous = this.#sequences.get(stream);
    if (previous !== undefined && event.sequenceNumber <= previous) return;
    if (this.#sequences.size >= MAX_RECORDS && previous === undefined) throw new CuaControlError("resource_limit");
    this.#sequences.set(stream, event.sequenceNumber);
    const key = this.#turnKey(scope, event.sessionId, event.turnId);
    if (event.kind === "turn-started") {
      const pendingKey = this.#pendingKey({ ...scope, commandId: event.inputId });
      const intent = this.#pending.get(pendingKey);
      this.#pending.delete(pendingKey);
      if (!intent || event.humanUser !== true || !event.messageId || !event.traceId ||
          (intent.sessionId !== null && intent.sessionId !== event.sessionId)) return;
      if (this.#turns.has(key) || this.#turns.size >= MAX_RECORDS) throw new CuaControlError("resource_limit");
      const context = { sessionId: event.sessionId, turnId: event.turnId,
        workspaceKey: scope.workspaceKey, traceId: event.traceId,
        source: "user", runtimeScope: "main", pluginId: CUA_OFFICIAL_PLUGIN_ID };
      this.#ports.registerTurn(context);
      this.#turns.set(key, { ...scope, ...context, messageId: event.messageId,
        inputId: event.inputId, generation: intent.generation });
      return;
    }
    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      this.#closeTurn(key);
    } else if (event.kind === "session-closed") {
      for (const [turnKey, turn] of this.#turns) {
        if (turn.ownerId === scope.ownerId && turn.hostId === scope.hostId &&
            turn.workspaceKey === scope.workspaceKey && turn.sessionId === event.sessionId) this.#closeTurn(turnKey);
      }
      for (const [pendingKey, intent] of this.#pending) {
        if (intent.hostId === scope.hostId && intent.sessionId === event.sessionId) this.#pending.delete(pendingKey);
      }
    } else if (event.kind === "tool-scheduled" && event.toolName === "mcp__node_repl__js") {
      const turn = this.#turns.get(key);
      if (!turn) return;
      const callKey = this.#callKey(scope, event.sessionId, event.turnId, event.toolCallId);
      if (this.#calls.has(callKey) || this.#scheduledCalls.has(callKey) ||
          this.#calls.size + this.#scheduledCalls.size >= MAX_RECORDS) throw new CuaControlError("resource_limit");
      // Permission waits hold no executable call; the trusted start event begins its bounded lifetime.
      this.#scheduledCalls.set(callKey, { ...turn, toolCallId: event.toolCallId });
    } else if (event.kind === "tool-started") {
      const candidates = [...this.#scheduledCalls].filter(([, call]) => this.#matchesTool(call, scope, event));
      if (candidates.length !== 1) return;
      const [callKey, scheduled] = candidates[0];
      this.#scheduledCalls.delete(callKey);
      if (event.toolName !== undefined && event.toolName !== "mcp__node_repl__js") return;
      const turn = this.#turns.get(this.#turnKey(scheduled, scheduled.sessionId, scheduled.turnId));
      if (!turn || turn.generation !== scheduled.generation) return;
      this.#calls.set(callKey, { ...turn, toolCallId: event.toolCallId,
        callId: this.#ports.registerCall(turn.sessionId, turn.turnId),
        expiresAt: this.#ports.now() + CUA_LIMITS.callTtlMs });
    } else if (event.kind === "tool-completed") {
      for (const [callKey, call] of [...this.#scheduledCalls, ...this.#calls]) {
        if (this.#matchesTool(call, scope, event)) this.#closeCall(callKey);
      }
    }
  }

  resolveCall(input) {
    this.#expire();
    if (input.runtimeScope !== "main") throw new CuaControlError("not_authorized");
    const call = this.#calls.get(this.#callKey(input, input.sessionId, input.turnId, input.toolCallId));
    if (!call || call.expiresAt <= this.#ports.now()) throw new CuaControlError("not_authorized", "No live user-selected Computer Use call.");
    return { ...call };
  }
  closeToolCall(input) {
    this.#closeCall(this.#callKey(input, input.sessionId, input.turnId, input.toolCallId));
  }

  isTurnActive(input) {
    return input.runtimeScope === "main" && this.#turns.has(this.#turnKey(input, input.sessionId, input.turnId));
  }

  revokeHost(hostId) {
    for (const [key, turn] of this.#turns) if (turn.hostId === hostId) this.#closeTurn(key);
    for (const [key, intent] of this.#pending) if (intent.hostId === hostId) this.#pending.delete(key);
    for (const key of this.#sequences.keys()) if (JSON.parse(key)[1] === hostId) this.#sequences.delete(key);
  }

  revokeOwner(ownerId) {
    for (const [key, intent] of this.#intents) if (intent.ownerId === ownerId) this.#intents.delete(key);
    for (const [key, turn] of this.#turns) if (turn.ownerId === ownerId) this.#closeTurn(key);
    for (const [key, intent] of this.#pending) if (intent.ownerId === ownerId) this.#pending.delete(key);
    for (const key of this.#sequences.keys()) if (JSON.parse(key)[0] === ownerId) this.#sequences.delete(key);
  }

  clear() {
    for (const key of this.#turns.keys()) this.#closeTurn(key);
    this.#intents.clear(); this.#pending.clear(); this.#sequences.clear();
  }

  #closeTurn(key) {
    const turn = this.#turns.get(key);
    if (!turn) return;
    this.#turns.delete(key);
    for (const [callKey, call] of [...this.#scheduledCalls, ...this.#calls]) {
      if (call.ownerId === turn.ownerId && call.hostId === turn.hostId &&
          call.workspaceKey === turn.workspaceKey && call.sessionId === turn.sessionId &&
          call.turnId === turn.turnId) this.#closeCall(callKey);
    }
    this.#ports.closeTurn(turn.sessionId, turn.turnId);
  }

  #closeCall(key) {
    this.#scheduledCalls.delete(key);
    const call = this.#calls.get(key);
    this.#calls.delete(key);
    if (call) this.#ports.closeCall(call.callId);
  }

  #expire() {
    const now = this.#ports.now();
    for (const [key, intent] of this.#intents) if (intent.expiresAt <= now) this.#intents.delete(key);
    for (const [key, intent] of this.#pending) if (intent.expiresAt <= now) this.#pending.delete(key);
    for (const [key, call] of this.#calls) if (call.expiresAt <= now) this.#closeCall(key);
  }

  #matchesTool(call, scope, event) {
    return call.ownerId === scope.ownerId && call.hostId === scope.hostId &&
      call.workspaceKey === scope.workspaceKey && call.sessionId === event.sessionId &&
      call.toolCallId === event.toolCallId && (event.turnId === undefined || call.turnId === event.turnId);
  }

  #pendingKey(input) { return JSON.stringify([input.ownerId, input.hostId, input.workspaceKey, input.commandId]); }
  #turnKey(scope, sessionId, turnId) { return JSON.stringify([scope.ownerId, scope.hostId, scope.workspaceKey, sessionId, turnId]); }
  #callKey(scope, sessionId, turnId, toolCallId) { return JSON.stringify([scope.ownerId, scope.hostId, scope.workspaceKey, sessionId, turnId, toolCallId]); }
}
