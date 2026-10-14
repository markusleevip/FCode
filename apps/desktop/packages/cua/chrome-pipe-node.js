import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CuaControlError } from "./control-contract.js";

const PROFILE_OWNER = Symbol("fresh-profile-owner");

/** Main-only transport to one owned, normally installed, headful Chrome instance. */
export class CuaChromePipe {
  #child;
  #profile;
  #sequence = 0;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closing;
  #exited;
  #targetListeners = new Set();

  static async start({ executablePath, cacheDirectory, spawnProcess = spawn }) {
    if (!isAbsolute(executablePath) || !isAbsolute(cacheDirectory)) throw new CuaControlError("invalid_request");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const profile = await mkdtemp(join(cacheDirectory, "chrome-task-"));
    try { return new CuaChromePipe(executablePath, profile, spawnProcess, PROFILE_OWNER); }
    catch (error) { await rm(profile, { recursive: true, force: true }); throw error; }
  }

  constructor(executablePath, profile, spawnProcess, owner) {
    if (owner !== PROFILE_OWNER) throw new CuaControlError("not_authorized");
    this.#profile = profile;
    this.#child = spawnProcess(executablePath, [
      `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-startup-window",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
      "--window-size=1280,800",
      "--force-renderer-accessibility",
    ], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8" },
    });
    this.#exited = new Promise((resolve) => {
      this.#child.once("exit", () => { this.#fail("browser_exited"); resolve(); });
      this.#child.once("error", () => { this.#fail("browser_unavailable"); resolve(); });
    });
    const outgoing = this.#child.stdio[3];
    const incoming = this.#child.stdio[4];
    if (!outgoing || !incoming) {
      this.#fail("browser_unavailable");
      void this.close();
      return;
    }
    outgoing.on("error", () => this.#fail("browser_exited"));
    incoming.on("error", () => this.#fail("browser_exited"));
    incoming.on("end", () => this.#fail("browser_exited"));
    incoming.on("data", (chunk) => this.#receive(chunk));
  }

  get pid() { return this.#child.pid; }
  get running() { return !this.#closed; }

  onTargetCreated(listener) {
    if (typeof listener !== "function" || this.#targetListeners.size >= 4) throw new CuaControlError("invalid_request");
    this.#targetListeners.add(listener);
    return () => this.#targetListeners.delete(listener);
  }

  request(method, params = {}, sessionId, signal, timeoutMs = 10_000) {
    if (this.#closed) return Promise.reject(new CuaControlError("browser_unavailable"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (typeof method !== "string" || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
      return Promise.reject(new CuaControlError("invalid_request"));
    }
    if (this.#pending.size >= 16 && method !== "Browser.close") return Promise.reject(new CuaControlError("control_busy"));
    const id = ++this.#sequence;
    const data = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    if (data.length > 1024 * 1024) return Promise.reject(new CuaControlError("resource_limit"));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const diagnose = (code) => console.warn("[computer-use] Chrome request interrupted", {
        method, code, elapsedMs: Math.round(performance.now() - started),
      });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#pending.delete(id); };
      const abort = () => {
        diagnose(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "backend_timeout" : "canceled");
        cleanup(); reject(signal.reason);
      };
      const timer = setTimeout(() => { diagnose("backend_timeout"); cleanup(); reject(new CuaControlError("backend_timeout")); }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdio[3].write(data, (error) => { if (error) this.#fail("browser_exited"); });
    });
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (!this.#closed) await this.request("Browser.close", {}, undefined, undefined, 1000).catch(() => {});
      const terminate = setTimeout(() => { if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM"); }, 250);
      const force = setTimeout(() => { if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL"); }, 1000);
      await this.#exited;
      clearTimeout(terminate); clearTimeout(force);
      this.#fail("browser_exited");
      // Only the fresh profile created by start() belongs to this transport.
      await rm(this.#profile, { recursive: true, force: true });
    })();
    return this.#closing;
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 32 * 1024 * 1024) { this.#fail("resource_limit"); void this.close(); return; }
    let delimiter;
    while ((delimiter = this.#buffer.indexOf(0)) !== -1) {
      const data = this.#buffer.subarray(0, delimiter);
      this.#buffer = this.#buffer.subarray(delimiter + 1);
      try {
        const response = JSON.parse(data.toString("utf8"));
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid envelope");
        // Events are internal to Chrome; never project unbounded page payloads to a model or log.
        if (response.id === undefined) {
          if (response.method === "Target.targetCreated") {
            const target = response.params?.targetInfo;
            if (target && typeof target.targetId === "string" && target.targetId.length <= 256 &&
                typeof target.type === "string" && target.type.length <= 32) {
              // Project identity only. Never forward URL, title, console or network event payloads.
              for (const listener of this.#targetListeners) {
                try { listener({ targetId: target.targetId, type: target.type }); } catch { this.#fail("protocol_invalid"); void this.close(); }
              }
            }
          }
          continue;
        }
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        if (response.error) {
          console.warn("[computer-use] Chrome protocol rejected", { method: pending.method,
            code: Number.isSafeInteger(response.error.code) ? response.error.code : null });
          pending.reject(new CuaControlError("browser_protocol_failed"));
        }
        else if (response.result && typeof response.result === "object" && !Array.isArray(response.result)) pending.resolve(response.result);
        else throw new Error("Invalid result");
      } catch { this.#fail("protocol_invalid"); void this.close(); return; }
    }
  }

  #fail(code) {
    this.#closed = true;
    this.#targetListeners.clear();
    for (const pending of this.#pending.values()) pending.reject(new CuaControlError(code));
    this.#buffer = Buffer.alloc(0);
  }
}
