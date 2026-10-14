import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlTransport } from "@fcode/cua/control-transport/node";
import { CuaControlError } from "@fcode/cua/control-contract";
import {
  HostResponseTypes,
  FCODE_CUA_BROKER_SOCKET_ENV_KEY,
  FCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ComputerUseHostCommand,
  type ComputerUseHostResult,
  type ComputerUseSubmissionPort,
} from "@fcode/shared";

const SUBMISSION_TIMEOUT_MS = 5_000;
const INVOCATION_TTL_MS = 120_000;

export function createComputerUseMainBridge(postToMain: (message: {
  type: typeof HostResponseTypes.ComputerUseControlRequest;
  requestId: string;
  command: ComputerUseHostCommand;
}) => void): ComputerUseSubmissionPort & {
  handleResult(requestId: string, result: ComputerUseHostResult): void;
  dispose(): Promise<void>;
} {
  const pending = new Map<string, { resolve(result: ComputerUseHostResult): void; timer: ReturnType<typeof setTimeout> }>();
  const selectedCommands = new Map<string, number>();
  const selectedTurns = new Set<string>();
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\fcode-cua-${randomUUID()}` : join(tmpdir(), `fcrc-${randomUUID()}.sock`);
  const token = randomBytes(32).toString("hex");
  const send = (command: ComputerUseHostCommand, timeoutMs = SUBMISSION_TIMEOUT_MS, signal?: AbortSignal) => {
    if (disposed) return Promise.reject(new CuaControlError("canceled", "Computer Use Host bridge is closed."));
    signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise<ComputerUseHostResult>((resolve, reject) => {
      const abort = () => {
        pending.delete(requestId); clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (command.kind === "execute-control") {
          try { postToMain({ type: HostResponseTypes.ComputerUseControlRequest,
            requestId: randomUUID(), command: { kind: "cancel-call", context: command.context } }); }
          catch { /* Host disconnect already revokes this call in Main. */ }
        }
        reject(signal?.reason ?? new CuaControlError("canceled"));
      };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const settle = (result: ComputerUseHostResult) => {
        signal?.removeEventListener("abort", abort); clearTimeout(timer); resolve(result);
      };
      pending.set(requestId, { resolve: settle, timer });
      try { postToMain({ type: HostResponseTypes.ComputerUseControlRequest, requestId, command }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); }
    });
  };
  const transport = createControlTransport({ socketPath, token,
    execute: async (context, action, signal) => {
      if (!selectedTurns.has(JSON.stringify([context.workspaceKey, context.sessionId, context.turnId]))) {
        throw new CuaControlError("not_authorized", "Use Continue computer task or select Computer Use for this new user task.",
          { stage: "selection", reason: "task_not_selected", retryable: false, requiresUserAction: true });
      }
      const result = await send({ kind: "execute-control", context, action }, 120_000, signal);
      if (!result.ok) throw new CuaControlError(result.error.code, result.error.message, result.error);
      if (!result.result) throw new CuaControlError("invalid_response");
      return result.result;
    },
  });
  const releaseIfIdle = () => {
    if (!selectedCommands.size && !selectedTurns.size) void transport.stop();
  };
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (disposed || !selectedCommands.size) return;
    const delay = Math.max(0, Math.min(...selectedCommands.values()) - Date.now());
    expiryTimer = setTimeout(() => {
      for (const [key, expiresAt] of selectedCommands) if (expiresAt <= Date.now()) selectedCommands.delete(key);
      releaseIfIdle(); scheduleExpiry();
    }, delay);
    expiryTimer.unref();
  };
  return {
    getRuntimeEnv: () => ({ [FCODE_CUA_BROKER_SOCKET_ENV_KEY]: socketPath, [FCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: token }),
    async disableComputerUse() {
      const result = await send({ kind: "disable" });
      selectedCommands.clear(); selectedTurns.clear(); scheduleExpiry(); await transport.stop();
      if (!result.ok) throw new CuaControlError(result.error.code, result.error.message);
    },
    async registerInvocation(input) {
      if (disposed) throw new Error("Computer Use Host bridge is closed.");
      const result = await send({ kind: "register-invocation", ...input });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      if (disposed) throw new CuaControlError("canceled");
      selectedCommands.set(JSON.stringify([input.workspaceKey, input.commandId]), Date.now() + INVOCATION_TTL_MS);
      console.info(`[computer-use-lifecycle] registered command=${input.commandId}`);
      scheduleExpiry();
      await transport.start();
    },
    acceptOperationEvent(workspaceKey, event) {
      if (disposed) return;
      for (const [key, expiresAt] of selectedCommands) if (expiresAt <= Date.now()) selectedCommands.delete(key);
      scheduleExpiry(); releaseIfIdle();
      const turnKey = JSON.stringify([workspaceKey, event.sessionId, "turnId" in event ? event.turnId : undefined]);
      if (event.kind === "turn-started") {
        const commandKey = JSON.stringify([workspaceKey, event.inputId]);
        if (!selectedCommands.delete(commandKey)) return;
        scheduleExpiry();
        selectedTurns.add(turnKey);
        console.info(`[computer-use-lifecycle] bound session=${event.sessionId} turn=${event.turnId}`);
      } else if (event.kind === "session-closed") {
        let selected = false;
        for (const key of selectedTurns) {
          const [workspace, session] = JSON.parse(key);
          if (workspace === workspaceKey && session === event.sessionId) {
            selectedTurns.delete(key); selected = true;
          }
        }
        if (!selected) return;
      } else {
        // Runtime start/result events may omit turnId; Main resolves their exact queued invocation.
        if (!selectedTurns.has(turnKey) && !((event.kind === "tool-started" || event.kind === "tool-completed") && !event.turnId &&
          [...selectedTurns].some((key) => {
            const [workspace, session] = JSON.parse(key);
            return workspace === workspaceKey && session === event.sessionId;
          }))) return;
        if (event.kind === "turn-completed" || event.kind === "turn-failed") {
          selectedTurns.delete(turnKey);
          console.info(`[computer-use-lifecycle] revoked reason=${event.kind} session=${event.sessionId} turn=${event.turnId}`);
        }
      }
      postToMain({ type: HostResponseTypes.ComputerUseControlRequest, requestId: randomUUID(),
        command: { kind: "operation-event", workspaceKey, event } });
      releaseIfIdle();
    },
    handleResult(requestId, result) {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(result);
    },
    async dispose() {
      disposed = true;
      clearTimeout(expiryTimer); expiryTimer = undefined;
      selectedCommands.clear();
      selectedTurns.clear();
      for (const [requestId, entry] of pending) {
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: { code: "canceled", message: "Computer Use Host disconnected." } });
      }
      await transport.stop();
    },
  };
}
