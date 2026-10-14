import {
  CUA_LIMITS, CUA_OFFICIAL_PLUGIN_ID, CuaControlError,
  assertRecord, assertString, canonicalAction, isControlMethod, isInputMethod, validateControlAction,
} from "./control-contract.js";
import { mapFramePoint, sameRegion, sameTarget } from "./control-geometry.js";
import { CuaInputApprovalLedger } from "./control-approval.js";

/** Host-owned state. None of the registration or grant methods are exposed to model code. */
export class CuaControlAuthority {
  #ports;
  #enabled = false;
  #turns = new Map();
  #calls = new Map();
  #grants = new Map();
  #observations = new Map();
  #observationSequence = 0;
  #results = new Map();
  #lease;
  #epoch = 0;
  #revision = 0;
  #controllers = new Map();
  #stopPending = 0;
  #uncertain = false;
  #queued = 0;
  #tail = Promise.resolve();
  #unsettledInputs = 0;
  #approvals;

  constructor(ports) {
    this.#ports = ports;
    this.#approvals = new CuaInputApprovalLedger(ports);
  }

  get state() {
    return { enabled: this.#enabled, epoch: this.#epoch, queued: this.#queued,
      status: this.#stopPending || this.#uncertain ? "stopping" : this.#lease ? "active" : "idle",
      lease: this.#lease ? { ...this.#lease } : null };
  }

  setEnabled(enabled) {
    this.#enabled = enabled === true;
    if (!this.#enabled) {
      const stopping = this.stop();
      this.#turns.clear();
      this.#calls.clear();
      this.#grants.clear();
      return stopping;
    }
  }

  registerTurn(value) {
    const fields = ["sessionId", "turnId", "workspaceKey", "traceId", "source", "runtimeScope", "pluginId"];
    const context = assertRecord(value, fields);
    fields.forEach((key) => assertString(context[key], 256));
    if (!this.#enabled || context.source !== "user" || context.runtimeScope !== "main" ||
        context.pluginId !== CUA_OFFICIAL_PLUGIN_ID) {
      throw new CuaControlError("not_authorized", "Explicit user selection is required.");
    }
    const key = this.#turnKey(context);
    if (this.#turns.has(key)) throw new CuaControlError("invalid_request", "Turn is already registered.");
    this.#turns.set(key, structuredClone(context));
  }

  closeTurn(sessionId, turnId) {
    const key = this.#turnKey({ sessionId, turnId });
    this.#turns.delete(key);
    this.#approvals.revokeTurn(sessionId, turnId);
    for (const [id, call] of this.#calls) if (this.#turnKey(call) === key) this.#calls.delete(id);
    for (const [id, grant] of this.#grants) {
      if (grant.sessionId === sessionId && grant.scope === "turn" && grant.turnId === turnId) this.#grants.delete(id);
    }
    for (const [id, value] of this.#observations) if (this.#turnKey(value) === key) this.#observations.delete(id);
    for (const [id, value] of this.#results) if (value.turnKey === key) this.#results.delete(id);
    for (const [controller, owner] of this.#controllers) {
      if (owner.turnKey === key) controller.abort(new CuaControlError("canceled"));
    }
    if (this.#lease?.sessionId === sessionId && this.#lease.turnId === turnId) return this.stop();
  }

  closeSession(sessionId) {
    for (const turn of this.#turns.values()) if (turn.sessionId === sessionId) this.closeTurn(sessionId, turn.turnId);
    for (const [id, grant] of this.#grants) if (grant.sessionId === sessionId) this.#grants.delete(id);
  }

  registerCall(sessionId, turnId) {
    const context = this.#turns.get(this.#turnKey({ sessionId, turnId }));
    if (!this.#enabled || !context) throw new CuaControlError("not_authorized");
    const callId = this.#ports.createId();
    this.#calls.set(callId, { ...context, expiresAt: this.#ports.now() + CUA_LIMITS.callTtlMs });
    return callId;
  }

  closeCall(callId) {
    this.#calls.delete(callId);
    this.#approvals.revokeCall(callId);
    for (const [controller, owner] of this.#controllers) {
      if (owner.callId === callId) controller.abort(new CuaControlError("canceled"));
    }
  }

  grantApplication(callId, target, methods, scope = "turn") {
    const call = this.#call(callId);
    if (!["turn", "session"].includes(scope) || !Array.isArray(methods) || !methods.length || methods.some((method) => !isControlMethod(method))) {
      throw new CuaControlError("invalid_request");
    }
    for (const key of ["appId", "instanceId"]) assertString(target[key]);
    if (!Number.isInteger(target.pid) || target.pid < 1) throw new CuaControlError("invalid_request");
    if (this.#ports.isDenied(target)) throw new CuaControlError("not_authorized");
    const grantId = this.#ports.createId();
    this.#revision++;
    this.#approvals.clear();
    this.#grants.set(grantId, { sessionId: call.sessionId, turnId: call.turnId,
      scope, target: structuredClone(target), methods: new Set(methods) });
    return grantId;
  }

  revokeGrant(grantId) {
    const grant = this.#grants.get(grantId);
    this.#grants.delete(grantId);
    this.#revision++;
    this.#approvals.clear();
    if (grant?.sessionId === this.#lease?.sessionId) return this.stop();
  }

  acquire(callId) {
    const call = this.#call(callId);
    if ((this.#unsettledInputs && !this.#lease) || this.#stopPending || this.#uncertain) {
      throw new CuaControlError("execution_uncertain");
    }
    if (this.#lease && this.#lease.expiresAt <= this.#ports.now()) {
      void this.stop();
      throw new CuaControlError("control_busy", "Expired lease is being released.");
    }
    if (this.#lease && (this.#lease.sessionId !== call.sessionId || this.#lease.turnId !== call.turnId)) {
      throw new CuaControlError("control_busy");
    }
    if (!this.#lease) {
      this.#lease = { leaseId: this.#ports.createId(), epoch: ++this.#epoch,
        sessionId: call.sessionId, turnId: call.turnId, expiresAt: 0 };
    }
    this.#lease.expiresAt = this.#ports.now() + CUA_LIMITS.leaseTtlMs;
    return { ...this.#lease };
  }

  heartbeat(callId, leaseId) {
    const call = this.#call(callId);
    this.#assertLease(call);
    if (this.#lease.leaseId !== leaseId) throw new CuaControlError("not_authorized");
    this.#lease.expiresAt = this.#ports.now() + CUA_LIMITS.leaseTtlMs;
  }

  heartbeatTurn(sessionId, turnId, leaseId) {
    const turn = this.#turns.get(this.#turnKey({ sessionId, turnId }));
    if (!this.#enabled || !turn) throw new CuaControlError("not_authorized");
    this.#assertLease(turn);
    if (this.#lease.leaseId !== leaseId) throw new CuaControlError("not_authorized");
    this.#lease.expiresAt = this.#ports.now() + CUA_LIMITS.leaseTtlMs;
  }

  stop() {
    this.#epoch++;
    this.#revision++;
    this.#lease = undefined;
    this.#observations.clear();
    this.#approvals.clear();
    for (const controller of this.#controllers.keys()) controller.abort(new CuaControlError("canceled"));
    // Release uses an independent backend control path, never the normal action queue.
    this.#stopPending++;
    return Promise.resolve().then(() => this.#ports.stop()).then(() => {
      this.#uncertain = false;
    }, () => {
      this.#uncertain = true;
    }).finally(() => { this.#stopPending--; });
  }

  execute(callId, rawAction, signal) {
    const call = this.#call(callId);
    const action = validateControlAction(rawAction);
    const fingerprint = canonicalAction({ callId, action });
    const existing = this.#results.get(action.actionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CuaControlError("invalid_request", "Action ID was reused.");
      return existing.result;
    }
    if (this.#results.size >= CUA_LIMITS.resultCount) {
      throw new CuaControlError("resource_limit", "Action ledger capacity exceeded.");
    }
    const result = this.#execute(callId, call, action, signal);
    this.#results.set(action.actionId, { fingerprint, result, turnKey: this.#turnKey(call) });
    return result;
  }

  async #execute(callId, call, action, parentSignal) {
    const controller = new AbortController();
    const preparing = action.method === "prepare_input";
    const intended = preparing ? validateControlAction({ schemaVersion: 1, actionId: action.actionId,
      method: action.params.method, params: action.params.params }) : action;
    const input = isInputMethod(intended.method);
    const signals = [controller.signal, AbortSignal.timeout(input ? CUA_LIMITS.callTtlMs : CUA_LIMITS.actionTimeoutMs)];
    if (parentSignal) signals.push(parentSignal);
    let signal = AbortSignal.any(signals);
    this.#controllers.set(controller, { callId, turnKey: this.#turnKey(call) });
    const epoch = this.#epoch;
    const revision = this.#revision;
    try {
      signal.throwIfAborted();
      let observation;
      let target;
      const reference = intended.params.frameId ?? intended.params.stateId;
      if (reference) {
        observation = this.#observations.get(reference);
        if (!observation || observation.sessionId !== call.sessionId || observation.turnId !== call.turnId) {
          throw new CuaControlError("observation_stale", "No observation is registered for this task.");
        }
        if (observation.expiresAt <= this.#ports.now()) throw new CuaControlError("observation_stale", "The Host observation expired before approval.");
        target = observation.target;
      } else if (intended.params.appId) {
        target = await this.#ports.resolveTarget(intended.params, signal);
      }
      if (target) this.#assertGrant(call, target, intended.method);
      if (input) {
        this.#assertLease(call);
        const request = { action: intended, target, observation, context: { ...call }, callId, epoch, revision };
        if (intended.params.approvalId) {
          this.#approvals.consume(intended.params.approvalId, request);
        } else {
          const decision = await this.#ports.requestApproval(request, signal);
          if (decision !== "allow") throw new CuaControlError("not_authorized");
        }
        signal = AbortSignal.any([signal, AbortSignal.timeout(CUA_LIMITS.actionTimeoutMs)]);
      }
      signal.throwIfAborted();
      this.#call(callId);
      if (revision !== this.#revision || epoch !== this.#epoch) throw new CuaControlError("permission_stale");
      if (preparing) {
        this.#assertLease(call);
        this.#assertGrant(call, target, intended.method);
        const current = await this.#ports.resolveTarget(target, signal);
        signal.throwIfAborted();
        this.#call(callId);
        if (revision !== this.#revision || epoch !== this.#epoch) throw new CuaControlError("permission_stale");
        if (!sameTarget(current, target)) throw new CuaControlError("target_changed");
        return { approvalId: this.#approvals.issue({ action: intended, target, observation,
          context: { ...call }, callId, epoch, revision }, this.#observationSequence),
          expiresInMs: Math.min(CUA_LIMITS.approvalTtlMs, call.expiresAt - this.#ports.now()) };
      }
      const run = async () => {
        signal.throwIfAborted();
        this.#call(callId);
        if (input) this.#assertLease(call);
        if (revision !== this.#revision || epoch !== this.#epoch) throw new CuaControlError("permission_stale");
        if (target) {
          this.#assertGrant(call, target, action.method);
          const current = await this.#ports.resolveTarget(target, signal);
          if (!sameTarget(current, target)) throw new CuaControlError("target_changed");
          if (observation) {
            if (!sameRegion(current.region, observation.region)) throw new CuaControlError("observation_stale", "The window geometry changed after approval.");
            if (observation.topologyVersion !== current.topologyVersion) throw new CuaControlError("observation_stale", "The display topology changed after approval.");
            if (observation.expiresAt <= this.#ports.now()) throw new CuaControlError("observation_stale", "The Host observation expired while awaiting approval.");
          }
        }
        signal.throwIfAborted();
        this.#call(callId);
        if (revision !== this.#revision || epoch !== this.#epoch) throw new CuaControlError("permission_stale");
        if (input) this.#assertLease(call);
        let point;
        let endPoint;
        if (action.params.frameId) {
          point = mapFramePoint(observation, action.params.x, action.params.y);
          if (action.method === "drag") endPoint = mapFramePoint(observation, action.params.toX, action.params.toY);
        }
        signal.throwIfAborted();
        if (input && observation && this.#ports.consumeObservations) {
          if (this.#observations.get(observation.id) !== observation) throw new CuaControlError("observation_stale");
          // Reserve before dispatch, including failed/uncertain input; a new action ID cannot reuse pixels.
          this.#observations.delete(observation.id);
        }
        const result = await this.#ports.execute({ action, target, observation, point, endPoint,
          context: { ...call }, callId, approved: input, epoch, revision }, signal);
        signal.throwIfAborted();
        this.#call(callId);
        if (revision !== this.#revision || epoch !== this.#epoch) throw new CuaControlError("permission_stale");
        if (result.observation) {
          const value = result.observation;
          assertString(value.id, 128);
          if (this.#observations.has(value.id) || !sameRegion(value.region, target.region) ||
              value.topologyVersion !== target.topologyVersion) throw new CuaControlError("observation_stale");
          mapFramePoint(value, 0, 0);
          if (!sameTarget(value.target, target)) throw new CuaControlError("target_changed");
          this.#observations.set(value.id, { ...structuredClone(value), sessionId: call.sessionId,
            turnId: call.turnId, registeredSequence: ++this.#observationSequence,
            expiresAt: this.#ports.now() + CUA_LIMITS.frameTtlMs });
        }
        return result;
      };
      if (!input) return await run();
      if (this.#queued >= CUA_LIMITS.queueSize) throw new CuaControlError("control_busy", "Input queue is full.");
      this.#queued++;
      const previous = this.#tail;
      let release;
      this.#tail = new Promise((resolve) => { release = resolve; });
      let started = false;
      try {
        await waitForQueue(previous, signal);
        signal.throwIfAborted();
        started = true;
        this.#unsettledInputs++;
        return await run();
      } finally {
        if (started) this.#unsettledInputs--;
        this.#queued--;
        // Canceled waiters preserve order even while the previous native action is unsettled.
        void previous.then(release);
      }
    } finally {
      this.#controllers.delete(controller);
    }
  }

  #call(callId) {
    const call = this.#calls.get(callId);
    if (!this.#enabled || !call || !this.#turns.has(this.#turnKey(call)) || call.expiresAt <= this.#ports.now()) {
      throw new CuaControlError("not_authorized", "Call context is stale or unavailable.");
    }
    return call;
  }

  #assertGrant(call, target, method) {
    if (this.#ports.isDenied(target)) throw new CuaControlError("not_authorized");
    const allowed = [...this.#grants.values()].some((grant) => grant.sessionId === call.sessionId &&
      (grant.scope === "session" || grant.turnId === call.turnId) && grant.methods.has(method) &&
      grant.target.appId === target.appId && grant.target.pid === target.pid &&
      grant.target.instanceId === target.instanceId);
    if (!allowed) throw new CuaControlError("not_authorized", "Application capability is not granted.");
  }

  #assertLease(call) {
    if (!this.#lease || this.#lease.expiresAt <= this.#ports.now() ||
        this.#lease.sessionId !== call.sessionId || this.#lease.turnId !== call.turnId) {
      throw new CuaControlError("control_busy", "No valid control lease.");
    }
  }

  #turnKey(context) { return JSON.stringify([context.sessionId, context.turnId]); }
}

function waitForQueue(previous, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void previous.then(resolve).finally(() => signal.removeEventListener("abort", abort));
  });
}
