import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { CUA_LIMITS, CuaControlError, assertRecord, canonicalAction, isInputMethod, validateControlAction } from "./control-contract.js";
import { WINDOWS_NATIVE_PROTOCOL, WINDOWS_RESERVATION_TTL_MS, validateWindowsCatalog, validateWindowsHello, validateWindowsRequest, validateWindowsStatus, validateWindowsTarget } from "./windows-native-contract.js";
import { isWindowsDesktopInput, validateWindowsDesktopAction } from "./windows-desktop-contract.js";
import { WindowsNativeRpc } from "./windows-native-rpc-node.js";

const STOP_TIMEOUT_MS = 1000;
const CLOSE_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 3000;
const ALLOWED_ENV = ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)"];

function childEnvironment(environment) {
  const values = {};
  for (const key of ALLOWED_ENV) {
    const entry = Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (entry && typeof entry[1] === "string") values[key] = entry[1];
  }
  return values;
}

async function connectControl(path, connectPipe, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connectPipe(path);
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", canceled); };
    const canceled = () => { clean(); socket.destroy(); reject(new CuaControlError("canceled")); };
    const timer = setTimeout(() => { clean(); socket.destroy(); reject(new CuaControlError("backend_timeout")); }, CONNECT_TIMEOUT_MS);
    socket.once("error", () => { clean(); reject(new CuaControlError("identity_invalid")); });
    socket.once("connect", () => { clean(); resolve(socket); });
    signal?.addEventListener("abort", canceled, { once: true });
    if (signal?.aborted) canceled();
  });
}

/** GUI Main owns this transport. Neither secrets nor raw native requests enter the REPL. */
export class CuaWindowsNativeSession {
  #child;
  #data;
  #control;
  #socket;
  #secret = randomBytes(32);
  #nonce = randomBytes(32).toString("hex");
  #engineInstanceId;
  #epoch = 0;
  #closed = false;
  #tainted = false;
  #closing;

  static async start(options) {
    options.signal?.throwIfAborted();
    // The caller must use an OS-backed trust adapter, before a child can run.
    const identity = await options.verifyHelper(options.executablePath);
    options.signal?.throwIfAborted();
    assertRecord(identity, ["parentImageSha256"]);
    validateWindowsRequest({ schemaVersion: WINDOWS_NATIVE_PROTOCOL, id: "bootstrap", method: "hello", params: {
      secret: "00".repeat(32), nonce: "00".repeat(32), parentPid: options.parentPid ?? process.pid,
      parentImageSha256: identity.parentImageSha256,
    } });
    const session = new CuaWindowsNativeSession(options);
    try {
      const hello = await session.#data.request("hello", { secret: session.#secret.toString("hex"), nonce: session.#nonce,
        parentPid: options.parentPid ?? process.pid, parentImageSha256: identity.parentImageSha256 }, { signal: options.signal });
      const result = validateWindowsHello(hello, { nonce: session.#nonce, helperPid: session.#child.pid, arch: options.arch ?? process.arch });
      session.#engineInstanceId = result.status.engineInstanceId;
      session.#socket = await connectControl(result.controlPipe, options.connectPipe ?? connect, options.signal);
      session.#control = new WindowsNativeRpc({ input: session.#socket, output: session.#socket, channel: "control",
        onFailure: () => { void session.close(); } });
      const authenticated = await session.#control.request("authenticate", { secret: session.#secret.toString("hex"), nonce: session.#nonce }, { signal: options.signal });
      assertRecord(authenticated, ["authenticated"]);
      if (authenticated.authenticated !== true) throw new CuaControlError("identity_invalid");
      options.signal?.throwIfAborted();
      return session;
    } catch (error) { await session.close(); throw error; }
  }

  constructor(options) {
    this.#child = (options.spawnProcess ?? spawn)(options.executablePath, [], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: childEnvironment(options.environment ?? process.env),
    });
    this.#data = new WindowsNativeRpc({ input: this.#child.stdin, output: this.#child.stdout, channel: "data",
      onFailure: () => { void this.close(); } });
    this.#child.on("error", () => this.#data.fail("helper_unavailable"));
    this.#child.on("exit", () => { this.#closed = true; this.#data.fail("helper_exited"); this.#control?.fail("helper_exited"); });
  }

  get state() { return { running: !this.#closed, uncertain: this.#tainted }; }

  async status(signal) { return validateWindowsStatus(await this.#data.request("status", {}, { signal })); }
  async resolveTarget(target, signal) {
    const result = assertRecord(await this.#data.request("resolve_target", { target: validateWindowsTarget(target) }, { signal }), ["target"]);
    return validateWindowsTarget(result.target, true);
  }
  installedApplication(appId, signal) { return this.#data.request("installed_application", { appId }, { signal }); }
  openApplication(appId, epoch, signal) {
    return this.#data.request("open_application_ui", { appId, epoch }, { signal, onAbandon: () => this.#abandon(true) });
  }
  previewApplicationUi(target, signal) {
    return this.#data.request("preview_application_ui", { target: validateWindowsTarget(target, true) }, { signal });
  }
  applicationWindowUi(target, mode) {
    return this.#data.request("application_window_ui", { target: validateWindowsTarget(target, true), mode });
  }
  desktopDisplays(signal) { return this.#data.request("desktop_displays", {}, { signal }); }
  async desktopScope(scopeId, displayId, epoch, signal) {
    const result = assertRecord(await this.#control.request("desktop_scope", { scopeId, displayId, epoch }, { signal }), ["scopeId", "epoch"]);
    if (result.scopeId !== scopeId || result.epoch !== epoch) throw new CuaControlError("protocol_invalid");
  }

  async lease(epoch, ttlMs = CUA_LIMITS.leaseTtlMs) {
    if (this.#tainted) throw new CuaControlError("execution_uncertain");
    if (!this.#control) throw new CuaControlError("identity_invalid");
    const result = assertRecord(await this.#control.request("lease", { epoch, ttlMs }), ["epoch"]);
    if (result.epoch !== epoch) throw new CuaControlError("protocol_invalid");
    this.#epoch = epoch;
  }

  async execute(request, signal, assertCurrent = () => {}) {
    const { approvalId: _approvalId, ...params } = request.action.params;
    const action = request.action.schemaVersion === 2 ? validateWindowsDesktopAction(request.action) : validateControlAction({ ...request.action, params });
    const input = isInputMethod(action.method) || isWindowsDesktopInput(action.method);
    if (this.#tainted && input) throw new CuaControlError("execution_uncertain");
    signal?.throwIfAborted(); assertCurrent();
    const actionJson = canonicalAction(action);
    const actionDigest = createHash("sha256").update(actionJson, "utf8").digest("hex");
    const reservation = assertRecord(await this.#data.request("reserve_action", {
      actionDigest, epoch: request.epoch, ttlMs: WINDOWS_RESERVATION_TTL_MS,
    }, { signal }), ["reservationId", "engineInstanceId", "epoch", "expiresInMs"]);
    if (reservation.engineInstanceId !== this.#engineInstanceId || reservation.epoch !== request.epoch ||
        typeof reservation.reservationId !== "string" || !reservation.reservationId ||
        !Number.isSafeInteger(reservation.expiresInMs) || reservation.expiresInMs < 1 || reservation.expiresInMs > WINDOWS_RESERVATION_TTL_MS) {
      throw new CuaControlError("protocol_invalid");
    }
    // Reserving is asynchronous; cancellation or grant revocation cannot revive this action.
    signal?.throwIfAborted(); assertCurrent();
    const payload = canonicalAction({ reservationId: reservation.reservationId, actionJson, actionDigest,
      epoch: request.epoch, revision: request.revision, callId: request.callId,
      ...(request.target ? { target: validateWindowsTarget(request.target, true) } : {}),
      ...(request.observation ? { observationId: request.observation.id } : {}),
      ...(request.desktopScope ? { desktopScope: request.desktopScope } : {}),
    });
    const mac = createHmac("sha256", this.#secret).update(payload, "utf8").digest("hex");
    try {
      const result = await this.#data.request("execute", { payload, mac }, { signal,
        onAbandon: () => this.#abandon(input) });
      return action.method === "list_apps" ? validateWindowsCatalog(result) : result;
    } catch (error) {
      if (input && error instanceof CuaControlError && ["backend_timeout", "helper_exited", "protocol_invalid", "resource_limit"].includes(error.code)) {
        this.#tainted = true;
        throw new CuaControlError("execution_uncertain");
      }
      if (error instanceof CuaControlError && error.code === "execution_uncertain") this.#tainted = true;
      throw error;
    }
  }

  async #abandon(input) {
    if (input) this.#tainted = true;
    await this.stop();
  }

  async stop(epoch = this.#epoch) {
    if (this.#closed) return;
    try {
      if (!this.#control) throw new CuaControlError("identity_invalid");
      const result = assertRecord(await this.#control.request("stop", { epoch }, { timeoutMs: STOP_TIMEOUT_MS }),
        ["epoch", "dispatchQuiescent", "releaseConfirmed", "uncertain"]);
      if (result.epoch < epoch || !Number.isSafeInteger(result.epoch) || result.dispatchQuiescent !== true ||
          result.releaseConfirmed !== true || result.uncertain !== false) throw new CuaControlError("execution_uncertain");
    } catch {
      this.#tainted = true;
      await this.close();
      throw new CuaControlError("execution_uncertain");
    }
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = new Promise((resolve) => {
      const finish = () => { this.#closed = true; this.#secret.fill(0); this.#socket?.destroy();
        this.#data.fail("helper_exited"); this.#control?.fail("helper_exited"); resolve(); };
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) { finish(); return; }
      const timer = setTimeout(() => { this.#child.kill(); finish(); }, CLOSE_TIMEOUT_MS);
      this.#child.once("exit", () => { clearTimeout(timer); finish(); });
      // EOF is an independent supervisor shutdown signal, even if a data worker is stuck.
      this.#child.stdin.end();
    });
    return this.#closing;
  }
}
