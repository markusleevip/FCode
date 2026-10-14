import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { CUA_LIMITS, CuaControlError, assertRecord, assertString } from "./control-contract.js";
import { isWindowsDesktopMethod, validateComputerUseAction } from "./windows-desktop-contract.js";

/** Private Node REPL parent transport. Does not discover, launch or directly contact the native Helper. */
export function createComputerUseRuntimeClient(options) {
  let disposed = false;
  const sockets = new Set();
  const execute = async (input) => {
    if (disposed) throw new CuaControlError("canceled");
    assertString(options.brokerSocketPath, 1024);
    assertString(options.brokerToken, 256);
    const context = input.context;
    if (!context || context.runtimeScope !== "main" || context.workspaceIdentity || context.remoteSessionId) {
      throw new CuaControlError("not_authorized");
    }
    for (const field of ["sessionId", "turnId", "toolCallId", "workspaceKey"]) assertString(context[field], 512);
    const action = validateComputerUseAction({ schemaVersion: isWindowsDesktopMethod(input.toolName) ? 2 : 1, actionId: randomUUID(),
      method: input.toolName, params: input.arguments ?? {} });
    const result = await send({ socketPath: options.brokerSocketPath, token: options.brokerToken,
      context: { sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCallId,
        workspaceKey: context.workspaceKey, runtimeScope: context.runtimeScope }, action,
      signal: input.signal, sockets });
    const { image, ...summary } = result;
    const content = [{ type: "text", text: JSON.stringify(summary) }];
    if (image) {
      const value = assertRecord(image, ["mimeType", "data"]);
      if (value.mimeType !== "image/png") throw new CuaControlError("invalid_response");
      assertString(value.data, CUA_LIMITS.responseBytes);
      content.push({ type: "image", mimeType: value.mimeType, data: value.data });
    }
    return { content, structuredContent: summary };
  };
  return {
    execute,
    async closeSession() {},
    async dispose() { disposed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); },
  };
}

function send(input) {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(CUA_LIMITS.callTtlMs)]) :
    AbortSignal.timeout(CUA_LIMITS.callTtlMs);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const data = Buffer.from(`${JSON.stringify({ schemaVersion: 1, id, token: input.token,
      context: input.context, action: input.action })}\n`);
    if (data.length > CUA_LIMITS.requestBytes) { reject(new CuaControlError("resource_limit")); return; }
    const socket = createConnection(input.socketPath);
    input.sockets.add(socket);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      signal.removeEventListener("abort", abort); input.sockets.delete(socket); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(data));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CUA_LIMITS.responseBytes) { finish(new CuaControlError("resource_limit")); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = assertRecord(JSON.parse(buffer.subarray(0, newline).toString("utf8")),
          ["schemaVersion", "id", "ok", "result", "error"], ["schemaVersion", "id", "ok"]);
        if (response.schemaVersion !== 1 || response.id !== id || typeof response.ok !== "boolean") throw new CuaControlError("invalid_response");
        if (!response.ok) {
          const error = assertRecord(response.error, ["code", "message", "stage", "reason", "retryable", "requiresUserAction"], ["code", "message"]);
          assertString(error.code, 256); assertString(error.message, 512);
          throw new CuaControlError(error.code, error.message, error);
        }
        if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new CuaControlError("invalid_response");
        finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
    socket.once("error", () => finish(new CuaControlError("backend_unavailable",
      "No live Computer Use connection is available. Use Continue computer task or explicitly select Computer Use in a new message. Do not retry through shell or inspect plugin source.",
      { stage: "transport", reason: "host_transport_unavailable", retryable: false, requiresUserAction: true })));
    socket.once("close", () => finish(new CuaControlError("execution_uncertain", "Computer Use transport closed before returning a result.")));
    if (signal.aborted) abort();
  });
}
