import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { CUA_LIMITS, CuaControlError, assertRecord, assertString, controlErrorDetails } from "./control-contract.js";
import { validateComputerUseAction } from "./windows-desktop-contract.js";

/** Host adapter. The socket exists only while a submitted Computer Use task is live. */
export function createControlTransport(options) {
  let server, transition = Promise.resolve();
  const sockets = new Set();
  const serialize = (run) => {
    const result = transition.then(run); transition = result.catch(() => undefined); return result;
  };
  return {
    start: () => serialize(async () => {
      if (server) return;
      const candidate = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void handle(socket, options);
      });
      candidate.on("error", () => { for (const socket of sockets) socket.destroy(); });
      try {
        await new Promise((resolve, reject) => {
          const fail = (error) => { candidate.off("listening", ready); reject(error); };
          const ready = () => { candidate.off("error", fail); resolve(); };
          candidate.once("error", fail); candidate.once("listening", ready); candidate.listen(options.socketPath);
        });
        if (process.platform !== "win32") await chmod(options.socketPath, 0o600);
      } catch (error) {
        if (candidate.listening) {
          await new Promise((resolve) => candidate.close(resolve));
          if (process.platform !== "win32") await rm(options.socketPath, { force: true });
        }
        throw error;
      }
      candidate.unref(); server = candidate;
    }),
    stop: () => serialize(async () => {
      const current = server; server = undefined;
      if (!current) return;
      for (const socket of sockets) socket.destroy(); sockets.clear();
      await new Promise((resolve) => current.close(resolve));
      if (process.platform !== "win32") await rm(options.socketPath, { force: true });
    }),
  };
}

async function handle(socket, options) {
  const controller = new AbortController();
  let id = null, settled = false;
  const abort = () => controller.abort(new CuaControlError("canceled"));
  socket.once("close", abort); socket.on("error", abort);
  const timer = setTimeout(() => { abort(); socket.destroy(); }, CUA_LIMITS.callTtlMs);
  try {
    const raw = await readLine(socket, controller.signal);
    const input = assertRecord(JSON.parse(raw), ["schemaVersion", "id", "token", "context", "action"]);
    if (input.schemaVersion !== 1) throw new CuaControlError("invalid_request");
    assertString(input.id, 128); id = input.id;
    assertString(input.token, 256);
    const expected = Buffer.from(options.token), actual = Buffer.from(input.token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new CuaControlError("not_authorized");
    const context = assertRecord(input.context, ["sessionId", "turnId", "toolCallId", "workspaceKey", "runtimeScope"]);
    for (const key of Object.keys(context)) assertString(context[key], 512);
    if (context.runtimeScope !== "main") throw new CuaControlError("not_authorized");
    const action = validateComputerUseAction(input.action);
    const result = await options.execute(context, action, controller.signal);
    controller.signal.throwIfAborted();
    const response = Buffer.from(`${JSON.stringify({ schemaVersion: 1, id, ok: true, result })}\n`);
    if (response.length > CUA_LIMITS.responseBytes) throw new CuaControlError("resource_limit");
    settled = true; socket.end(response);
  } catch (error) {
    settled = true;
    if (socket.writable) socket.end(`${JSON.stringify({ schemaVersion: 1, id, ok: false, error: {
      code: error instanceof CuaControlError ? error.code : "execution_uncertain",
      message: error instanceof CuaControlError ? error.message : "Computer Use execution did not return a verified result.",
      ...controlErrorDetails(error),
    } })}\n`);
  } finally {
    clearTimeout(timer); socket.removeListener("close", abort);
    if (!settled) abort();
  }
}

function readLine(socket, signal) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => { socket.off("data", data); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const data = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CUA_LIMITS.requestBytes) { cleanup(); reject(new CuaControlError("resource_limit")); return; }
      const end = buffer.indexOf(10);
      if (end >= 0) { cleanup(); resolve(buffer.subarray(0, end).toString("utf8")); }
    };
    socket.on("data", data); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
