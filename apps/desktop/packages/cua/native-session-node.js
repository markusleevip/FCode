import { isDesktopMethod, isDesktopInput } from "./desktop-contract.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CUA_LIMITS, CuaControlError, assertRecord, assertString, isControlMethod, isInputMethod } from "./control-contract.js";

/** Desktop Host transport. This class is never exposed in the REPL bridge. */
export class CuaNativeSession {
  #child;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #epoch = 0;
  #closed = false;
  #closing;
  #tainted = false;
  #diagnostic;
  #inputRouting;

  constructor({ executablePath, diagnostic = false, inputRouting = "background", spawnProcess = spawn }) {
    assertString(executablePath);
    if (!["background", "foreground"].includes(inputRouting)) throw new CuaControlError("invalid_request");
    this.#diagnostic = diagnostic;
    this.#inputRouting = inputRouting;
    this.#child = spawnProcess(executablePath, diagnostic ? ["--diagnostic"] : [], {
      stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    this.#child.stdout.on("data", (chunk) => this.#receive(chunk));
    this.#child.on("error", () => this.#fail("helper_unavailable"));
    this.#child.on("exit", () => this.#fail("helper_exited"));
    this.#child.stdin.on("error", () => this.#fail("helper_exited"));
  }

  get state() { return { running: !this.#closed, uncertain: this.#tainted }; }

  status(signal) { return this.#request("status", {}, signal); }

  installedApplication(appId, signal) { return this.#request("installed_application", { appId }, signal); }

  openApplication(appId, epoch, signal) { return this.#request("open_application_ui", { appId, epoch }, signal); }

  previewApplicationUi(target, signal) { return this.#request("preview_application_ui", { target: this.#chromeTarget(target) }, signal, 4000); }

  applicationWindowUi(target, mode) {
    if (!["read", "show", "handover", "background"].includes(mode)) throw new CuaControlError("invalid_request");
    return this.#request("application_window_ui", { target: this.#chromeTarget(target), mode }, undefined, 4000);
  }

  previewWindowUi(signal) { return this.#request("preview_window_ui", {}, signal, 4000); }

  previewChromeUi(target, signal) { return this.#request("preview_chrome_ui", { target: this.#chromeTarget(target) }, signal, 4000); }

  chromeCredentialUi(params, signal) { return this.#request("chrome_credential_ui", params, signal, 4000); }

  chromeWindowUi(target, mode) {
    if (!["read", "show", "handover", "background"].includes(mode)) throw new CuaControlError("invalid_request");
    return this.#request("chrome_window_ui", { target: this.#chromeTarget(target), mode }, undefined, 4000);
  }

  #chromeTarget(target) {
    const { appId, pid, windowId, instanceId } = target;
    return { appId, pid, windowId, ...(instanceId ? { instanceId } : {}) };
  }

  controlWindowUi(mode) {
    if (!["show", "handover", "background"].includes(mode)) throw new CuaControlError("invalid_request");
    return this.#request("control_window_ui", { mode }, undefined, 4000);
  }

  credentialUiStatus(signal) { return this.#request("credential_ui_status", {}, signal); }

  focusCredentialUi(origin, epoch, signal) {
    assertString(origin);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new CuaControlError("invalid_request");
    return this.#request("focus_credential_ui", { origin, epoch }, signal);
  }

  requestPermissions(value, signal) {
    const params = assertRecord(value, ["accessibility", "screenRecording"]);
    if (typeof params.accessibility !== "boolean" || typeof params.screenRecording !== "boolean") {
      throw new CuaControlError("invalid_request");
    }
    return this.#request("request_permissions", params, signal, 120_000);
  }

  resolveTarget(target, signal) { return this.#request("resolve_target", target, signal).then((r) => r.target); }

  async lease(epoch, ttlMs = CUA_LIMITS.leaseTtlMs) {
    if (this.#tainted) throw new CuaControlError("execution_uncertain");
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > CUA_LIMITS.leaseTtlMs) {
      throw new CuaControlError("invalid_request");
    }
    await this.#request("lease", { epoch, ttlMs });
    this.#epoch = epoch;
  }

  desktopDisplays(signal) { return this.#request("desktop_displays", {}, signal); }

  desktopScope(scopeId, displayId, epoch, signal) {
    assertString(scopeId, 128); assertString(displayId, 128);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new CuaControlError("invalid_request");
    return this.#request("desktop_scope", { scopeId, displayId, epoch }, signal);
  }

  execute(request, signal, assertCurrent) {
    assertCurrent?.();
    if (isDesktopMethod(request.action.method)) {
      if (this.#tainted && isDesktopInput(request.action.method)) throw new CuaControlError("execution_uncertain");
      const { action, epoch, revision, callId, desktopScope } = request;
      assertString(desktopScope, 128);
      return this.#request("execute", { action, epoch, revision, callId, desktopScope }, signal).then((result) => { assertCurrent?.(); return result; });
    }
    if (this.#tainted && isInputMethod(request.action.method)) throw new CuaControlError("execution_uncertain");
    const { action, target, epoch, revision, callId, approved = false } = request;
    const { approvalId: _approvalId, ...params } = action.params;
    return this.#request("execute", { action: { ...action, params }, ...(target ? { target } : {}), epoch, revision, callId, approved, inputRouting: this.#inputRouting }, signal);
  }

  async stop(epoch = this.#epoch) {
    if (this.#closed) return;
    await this.#request("stop", { epoch }, undefined, 1000).catch(async () => { await this.close(); });
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => this.#child.kill("SIGKILL"), 250);
      this.#child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.#child.stdin.end();
    });
    return this.#closing;
  }

  #request(method, params, signal, timeoutMs = CUA_LIMITS.actionTimeoutMs) {
    if (this.#closed) return Promise.reject(new CuaControlError("helper_unavailable"));
    if (this.#diagnostic && method !== "status") return Promise.reject(new CuaControlError("not_authorized"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#pending.size >= CUA_LIMITS.queueSize && !["stop", "status", "lease"].includes(method)) {
      return Promise.reject(new CuaControlError("control_busy"));
    }
    const id = randomUUID();
    const uncertainInput = method === "open_application_ui" ||
      (method === "execute" && (isDesktopMethod(params.action?.method) ? isDesktopInput(params.action.method) : (!isControlMethod(params.action?.method) || isInputMethod(params.action.method))));
    const data = JSON.stringify({ schemaVersion: 1, id, method, params }) + "\n";
    if (Buffer.byteLength(data) > CUA_LIMITS.requestBytes) return Promise.reject(new CuaControlError("resource_limit"));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#pending.delete(id); };
      const cancel = async (reason) => {
        if (!this.#pending.has(id)) return;
        cleanup();
        if (method === "execute" || method === "open_application_ui") {
          // Stop first; never transfer control on the basis of an abandoned native promise.
          if (uncertainInput) this.#tainted = true;
          await this.stop();
        } else if (method === "stop") await this.close();
        reject(reason);
      };
      const abort = () => { void cancel(signal.reason); };
      const timer = setTimeout(() => { void cancel(new CuaControlError(uncertainInput ? "execution_uncertain" : "backend_timeout")); }, timeoutMs);
      this.#pending.set(id, { resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(data, (error) => { if (error) this.#fail("helper_exited"); });
    });
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > CUA_LIMITS.responseBytes) { this.#fail("resource_limit"); void this.close(); return; }
    let newline;
    while ((newline = this.#buffer.indexOf(10)) !== -1) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        const response = assertRecord(JSON.parse(line.toString("utf8")), ["schemaVersion", "id", "result", "error"], ["schemaVersion", "id"]);
        if (response.schemaVersion !== 1 || Boolean(response.error) === Boolean(response.result)) throw new Error("Invalid response");
        assertString(response.id, 128);
        if (response.id === "startup" && response.error) {
          const error = assertRecord(response.error, ["code", "message"]);
          this.#fail(assertString(error.code, 128));
          void this.close();
          return;
        }
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        if (response.error) {
          const error = assertRecord(response.error, ["code", "message"]);
          if (error.code === "execution_uncertain") this.#tainted = true;
          pending.reject(new CuaControlError(assertString(error.code, 128), assertString(error.message, 1024)));
        } else pending.resolve(assertRecord(response.result, Object.keys(response.result), []));
      } catch { this.#fail("protocol_invalid"); void this.close(); return; }
    }
  }

  #fail(code) {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new CuaControlError(code));
    this.#buffer = Buffer.alloc(0);
  }
}
