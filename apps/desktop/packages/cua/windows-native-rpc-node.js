import { randomUUID } from "node:crypto";
import { CUA_LIMITS, CuaControlError } from "./control-contract.js";
import { WINDOWS_CONTROL_BYTES, WINDOWS_NATIVE_PROTOCOL, parseWindowsJson, validateWindowsRequest, validateWindowsResponse } from "./windows-native-contract.js";

/** Bounded framing shared only by the two Windows private channels. */
export class WindowsNativeRpc {
  #input;
  #channel;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onFailure;

  constructor({ input, output, channel, onFailure }) {
    this.#input = input;
    this.#channel = channel;
    this.#onFailure = onFailure;
    output.on("data", (chunk) => this.#receive(chunk));
    output.on("end", () => this.fail("helper_exited"));
    output.on("error", () => this.fail("helper_exited"));
    input.on("error", () => this.fail("helper_exited"));
  }

  get closed() { return this.#closed; }

  request(method, params, { signal, timeoutMs = CUA_LIMITS.actionTimeoutMs, onAbandon } = {}) {
    if (this.#closed) return Promise.reject(new CuaControlError("helper_exited"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#pending.size >= CUA_LIMITS.queueSize) return Promise.reject(new CuaControlError("control_busy"));
    const id = randomUUID();
    const value = validateWindowsRequest({ schemaVersion: WINDOWS_NATIVE_PROTOCOL, id, method, params }, this.#channel);
    const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    if (bytes.length > (this.#channel === "control" ? WINDOWS_CONTROL_BYTES : CUA_LIMITS.requestBytes)) {
      return Promise.reject(new CuaControlError("resource_limit"));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#pending.delete(id); };
      const abandon = async (reason) => {
        if (!this.#pending.has(id)) return;
        cleanup();
        try { await onAbandon?.(reason); } catch { reason = new CuaControlError("execution_uncertain"); }
        reject(reason);
      };
      const abort = () => { void abandon(signal.reason); };
      const timer = setTimeout(() => { void abandon(new CuaControlError("backend_timeout")); }, timeoutMs);
      this.#pending.set(id, {
        resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.#input.write(bytes, (error) => { if (error) this.fail("helper_exited"); });
    });
  }

  #receive(chunk) {
    const byteLimit = this.#channel === "control" ? WINDOWS_CONTROL_BYTES : CUA_LIMITS.responseBytes;
    if (this.#buffer.length + chunk.length > byteLimit) { this.fail("resource_limit"); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let newline;
    while (!this.#closed && (newline = this.#buffer.indexOf(10)) !== -1) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const response = validateWindowsResponse(parseWindowsJson(text, byteLimit));
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        if (response.error) {
          pending.reject(new CuaControlError(response.error.code, `Windows Computer Use: ${response.error.code}`));
        } else pending.resolve(response.result);
      } catch { this.fail("protocol_invalid"); }
    }
  }

  fail(code) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new CuaControlError(code));
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
    this.#onFailure?.(code);
  }
}
