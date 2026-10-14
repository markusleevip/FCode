import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@fcode/cua";
import type { Logger } from "@fcode/contracts";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { canonicalAction, CuaControlError, controlErrorDetails } from "@fcode/cua/control-contract";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface NodeReplCuaBroker {
  connection: NodeReplCuaBrokerConnection;
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
  context: ComputerUseRuntimeContext;
}): NodeReplCuaBroker {
  const socketPath =
    input.platform === "win32"
      ? `\\\\.\\pipe\\fcode-node-repl-cua-${randomUUID()}`
      : join(tmpdir(), `znrc-${randomUUID()}.sock`);
  const token = randomBytes(32).toString("hex");
  const trustedContext = structuredClone(input.context);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    void handleSocket(socket, input.runtime, token, trustedContext).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    connection: { socketPath, token },
    ready,
    close: async () => {
      for (const socket of sockets) socket.destroy(); sockets.clear();
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (input.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}

async function handleSocket(
  socket: Socket,
  runtime: ComputerUseRuntime,
  token: string,
  trustedContext: ComputerUseRuntimeContext,
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId: string | undefined;
  socket.on("error", () => {
    if (!completed) abortController.abort();
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as {
      id?: unknown;
      token?: unknown;
      method?: unknown;
      input?: unknown;
      context?: unknown;
    };
    assertToken(payload.token, token);
    if (typeof payload.id !== "string" || typeof payload.method !== "string") {
      throw new Error("Computer Use broker request is invalid");
    }
    requestId = payload.id;
    const context = parseContext(payload.context);
    if (canonicalAction(context) !== canonicalAction(trustedContext)) {
      const fields = [...new Set([...Object.keys(context), ...Object.keys(trustedContext)])]
        .filter((field) => canonicalAction(context[field as keyof ComputerUseRuntimeContext]) !==
          canonicalAction(trustedContext[field as keyof ComputerUseRuntimeContext])).sort();
      throw new Error(`Computer Use Worker cannot replace its parent call context (fields: ${fields.join(", ")}).`);
    }
    const result = await runtime.execute({
      // Keep the parent comparison baseline private from runtime mutations.
      toolName: payload.method as never,
      arguments: payload.input,
      context: structuredClone(trustedContext),
      signal: abortController.signal,
    });
    completed = true;
    if (socket.writable) socket.end(`${JSON.stringify({ id: payload.id, ok: true, result })}\n`);
  } catch (error) {
    completed = true;
    if (socket.writable) {
      socket.end(
        `${JSON.stringify({ id: requestId ?? null, ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof CuaControlError && typeof error.code === "string" &&
              /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
            ? { errorCode: error.code, errorDetails: controlErrorDetails(error) } : {}) })}\n`,
      );
    }
  }
}

function assertToken(actualValue: unknown, expectedValue: string): void {
  if (typeof actualValue !== "string")
    throw new Error("Computer Use broker request is not authorized");
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Computer Use broker request is not authorized");
  }
}

function parseContext(value: unknown): ComputerUseRuntimeContext {
  if (!value || typeof value !== "object")
    throw new Error("Computer Use request context is missing");
  const context = value as Record<string, unknown>;
  const fields = ["sessionId", "runtimeScope", "workspaceKey", "workspacePath", "workspaceIdentity",
    "remoteSessionId", "turnId", "toolCallId", "clientMode", "deliveryKind", "trace"];
  if (Object.keys(context).some((key) => !fields.includes(key)) || context.runtimeScope !== "main") {
    throw new Error("Unknown Computer Use scope or context field.");
  }
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) {
    throw new Error("Computer Use request context is missing sessionId");
  }
  const workspacePath =
    typeof context.workspacePath === "string" ? context.workspacePath.trim() : "";
  const workspaceIdentity =
    typeof context.workspaceIdentity === "string" ? context.workspaceIdentity.trim() : "";
  const workspaceKey =
    (typeof context.workspaceKey === "string" ? context.workspaceKey.trim() : "") ||
    workspaceIdentity ||
    workspacePath;
  if (!workspaceKey) throw new Error("Computer Use request context is missing workspaceKey");
  return {
    sessionId: context.sessionId,
    runtimeScope: "main",
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(typeof context.remoteSessionId === "string"
      ? { remoteSessionId: context.remoteSessionId }
      : {}),
    ...(typeof context.turnId === "string" ? { turnId: context.turnId } : {}),
    ...(typeof context.toolCallId === "string" ? { toolCallId: context.toolCallId } : {}),
    ...(context.clientMode === "web-remote-replayable" ||
    context.clientMode === "desktop-continuous"
      ? { clientMode: context.clientMode }
      : {}),
    ...(context.deliveryKind === "web-remote-replayable" ||
    context.deliveryKind === "desktop-continuous"
      ? { deliveryKind: context.deliveryKind }
      : {}),
    ...(context.trace && typeof context.trace === "object"
      ? { trace: context.trace as ComputerUseRuntimeContext["trace"] }
      : {}),
  };
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
