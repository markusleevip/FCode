import { randomUUID } from "node:crypto";
import { nativeImage } from "electron";
import { CuaChromePipe } from "@fcode/cua/chrome-pipe/node";
import { CuaNativeSession } from "@fcode/cua/native-session/node";
import { CuaControlError, isInputMethod, type ControlTarget } from "@fcode/cua/control-contract";
import type { ControlRequest, ControlResult } from "@fcode/cua/control-authority";
import { resolveChromeExecutablePath } from "./chromeExecutableDiscovery.js";
import { readChromeSpace, readChromeNodes, projectChromeNodes, verifyChromePassword, readFocusedChromeInput,
  type ChromeSend, type ChromeSpace, type ChromeState } from "./desktopComputerUseChromeState.js";
import { dispatchChromeInput } from "./desktopComputerUseChromeInput.js";
import { computerUsePreviewFrameGeometrySchema } from "@fcode/shared";

/** Main-owned normal Chrome. Private transport and credentials never enter the model bridge. */
export class DesktopComputerUseChrome {
  private pipe?: CuaChromePipe;
  private sessionId?: string;
  private targetId?: string;
  private physical?: ControlTarget;
  private space?: ChromeSpace;
  private states = new Map<string, ChromeState>();
  private epoch = 0;
  private revokedEpoch = 0;
  private leaseGeneration = 0;
  private active = false;
  private unsettled = 0;
  private uncertain = false;
  private closing?: Promise<void>;
  private credential?: { binding: Record<string, unknown>; epoch: number };
  private removeTargetListener?: () => void;
  private readonly send: ChromeSend = (method, params = {}, signal) => {
    if (!this.pipe || !this.sessionId) throw new CuaControlError("backend_unavailable");
    return this.pipe.request(method, params, this.sessionId, signal);
  };

  private constructor(private native: CuaNativeSession) {}

  static async start(native: CuaNativeSession, cacheDirectory: string, signal: AbortSignal) {
    const driver = new DesktopComputerUseChrome(native);
    try {
      signal.throwIfAborted();
      const executablePath = await resolveChromeExecutablePath();
      if (!executablePath) throw new CuaControlError("backend_unavailable", "Install Google Chrome to use background website control.");
      driver.pipe = await CuaChromePipe.start({ executablePath, cacheDirectory });
      signal.throwIfAborted();
      await driver.pipe.request("Browser.getVersion", {}, undefined, signal);
      const context = await driver.pipe.request("Target.createBrowserContext", { disposeOnDetach: true }, undefined, signal);
      await driver.pipe.request("Browser.grantPermissions", { permissions: [], browserContextId: context.browserContextId }, undefined, signal);
      await driver.pipe.request("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: context.browserContextId }, undefined, signal);
      const created = await driver.pipe.request("Target.createTarget", { url: "about:blank", newWindow: true,
        background: true, browserContextId: context.browserContextId }, undefined, signal);
      driver.targetId = created.targetId as string;
      driver.removeTargetListener = driver.pipe.onTargetCreated((target) => {
        if (driver.active && target.type === "page" && target.targetId !== driver.targetId) void driver.failInput();
      });
      await driver.pipe.request("Target.setDiscoverTargets", { discover: true }, undefined, signal);
      const attached = await driver.pipe.request("Target.attachToTarget", { targetId: driver.targetId, flatten: true }, undefined, signal);
      driver.sessionId = attached.sessionId as string;
      await driver.send("Page.enable", {}, signal);
      await driver.send("Accessibility.enable", {}, signal);
      await driver.send("Page.setInterceptFileChooserDialog", { enabled: true }, signal);
      await driver.send("Input.setInterceptDrags", { enabled: true }, signal);
      const deadline = performance.now() + 3000;
      while (!driver.physical) {
        try { await driver.mapWindow(signal); }
        catch (error) {
          if (signal.aborted || performance.now() >= deadline || !(error instanceof CuaControlError) || error.code !== "target_changed") throw error;
          await new Promise((done) => setTimeout(done, 50));
        }
      }
      await driver.requireControl();
      signal.throwIfAborted();
      return driver;
    } catch (error) { await driver.close(); throw error; }
  }

  get application() {
    if (!this.pipe?.pid) throw new CuaControlError("backend_unavailable");
    return { appId: "com.google.Chrome", pid: this.pipe.pid };
  }
  get state() { return { running: Boolean(this.pipe?.running), uncertain: this.uncertain }; }
  owns(target: Record<string, unknown> | ControlTarget) {
    return Boolean(this.pipe?.pid && target.pid === this.pipe.pid && target.appId === "com.google.Chrome");
  }

  private async mapWindow(signal?: AbortSignal) {
    if (!this.pipe || !this.targetId) throw new CuaControlError("backend_unavailable");
    const window = await this.pipe.request("Browser.getWindowForTarget", { targetId: this.targetId }, undefined, signal);
    const bounds = window.bounds as Record<string, number>;
    const listed = await this.native.execute({ action: { schemaVersion: 1, actionId: randomUUID(), method: "list_windows", params: this.application },
      target: this.application as ControlTarget, epoch: this.epoch, revision: 0, callId: "private-chrome-window-map" }, signal);
    const candidates = (Array.isArray(listed.windows) ? listed.windows : []) as ControlTarget[];
    const matches = candidates.filter(({ region }) => region &&
      Math.abs(region.x - bounds.left) <= 2 && Math.abs(region.y - bounds.top) <= 2 &&
      Math.abs(region.width - bounds.width) <= 2 && Math.abs(region.height - bounds.height) <= 2);
    if (matches.length !== 1) throw new CuaControlError("target_changed", "The owned Chrome window cannot be identified uniquely.");
    const matched = matches[0];
    if (this.physical && (matched.windowId !== this.physical.windowId || matched.instanceId !== this.physical.instanceId)) {
      throw new CuaControlError("target_changed");
    }
    this.physical = matched;
    return matched;
  }

  private async requireControl() {
    const status = await this.native.status();
    if (status.screenLocked) throw new CuaControlError("desktop_locked");
    if (!status.accessibility || !status.screenRecording) throw new CuaControlError("permission_required");
    if (!this.physical) throw new CuaControlError("target_changed");
    // Foreground visibility does not transfer control; Main owns explicit takeover.
    return this.native.chromeWindowUi(this.physical, "read");
  }

  async resolveTarget(raw: Record<string, unknown> | ControlTarget, signal?: AbortSignal): Promise<ControlTarget> {
    if (!this.owns(raw)) throw new CuaControlError("not_authorized");
    if (raw.windowId === undefined) return this.native.resolveTarget(this.application, signal);
    const physical = await this.mapWindow(signal);
    if (raw.windowId !== physical.windowId || (raw.instanceId && raw.instanceId !== physical.instanceId)) throw new CuaControlError("target_changed");
    const space = await readChromeSpace(this.send, signal);
    if (this.space && this.space.document !== space.document) await this.clearCredential();
    this.space = space;
    return { ...physical, region: space.region,
      topologyVersion: `${space.version}:${physical.topologyVersion}:${JSON.stringify(physical.region)}` };
  }

  async lease(epoch: number) {
    if (this.uncertain || this.closing || !this.pipe?.running) throw new CuaControlError("execution_uncertain");
    if (epoch <= this.revokedEpoch || epoch < this.epoch) throw new CuaControlError("permission_stale");
    const generation = this.leaseGeneration;
    const targets = await this.pipe.request("Target.getTargets");
    const pages = Array.isArray(targets.targetInfos) ? targets.targetInfos.filter((target) =>
      target && typeof target === "object" && (target as Record<string, unknown>).type === "page") : [];
    if (pages.length !== 1 || (pages[0] as Record<string, unknown>).targetId !== this.targetId) {
      throw new CuaControlError("browser_target_changed", "Close additional task browser tabs before resuming.");
    }
    await this.requireControl();
    if (generation !== this.leaseGeneration || epoch <= this.revokedEpoch || epoch < this.epoch) {
      throw new CuaControlError("canceled");
    }
    this.epoch = epoch;
    this.active = true;
  }

  async execute(request: ControlRequest, signal: AbortSignal): Promise<ControlResult> {
    const { action, target } = request;
    if (!this.owns(target ?? action.params)) throw new CuaControlError("not_authorized");
    const input = isInputMethod(action.method);
    if (input && (!request.approved || !this.active || request.epoch !== this.epoch)) throw new CuaControlError("not_authorized");
    await this.requireControl();
    signal.throwIfAborted();
    if (action.method === "open_browser") {
      this.unsettled++;
      try {
        await this.clearCredential();
        this.states.clear();
        const navigated = await this.send("Page.navigate", { url: action.params.url }, signal);
        if (navigated.errorText || navigated.isDownload) throw new CuaControlError("navigation_failed");
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          try {
            const current = await this.resolveTarget({ ...this.application, windowId: this.physical!.windowId }, signal);
            return { target: current, browser: await this.metadata(), inputBackend: "normal-chrome-page" };
          } catch (error) {
            if (!(error instanceof CuaControlError) || error.code !== "target_changed") throw error;
            await new Promise((done) => setTimeout(done, 50));
            signal.throwIfAborted();
          }
        }
        throw new CuaControlError("navigation_failed");
      } catch (error) { await this.failInput(); throw error; }
      finally { this.unsettled--; }
    }
    if (!target?.windowId) {
      if (action.method === "list_windows" && this.physical) return { windows: [await this.resolveTarget(this.physical, signal)] };
      throw new CuaControlError("not_authorized");
    }
    if (["capture", "get_app_state"].includes(action.method)) {
      const current = await this.resolveTarget(target, signal);
      const space = this.space!;
      const nodes = action.method === "get_app_state" ? await readChromeNodes(this.send, signal) : [];
      const frame = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, signal);
      if (typeof frame.data !== "string" || frame.data.length > 20 * 1024 * 1024) throw new CuaControlError("resource_limit");
      let image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
      let { width, height } = image.getSize();
      if (!width || !height) throw new CuaControlError("capture_failed");
      const scale = Math.min(1, 1600 / Math.max(width, height));
      if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
      ({ width, height } = image.getSize());
      const after = await this.resolveTarget(target, signal);
      if (after.topologyVersion !== current.topologyVersion) throw new CuaControlError("observation_stale");
      const ownership = await this.requireControl();
      const id = randomUUID();
      for (const [key, value] of this.states) if (value.expiresAt <= performance.now()) this.states.delete(key);
      if (this.states.size >= 32) this.states.delete(this.states.keys().next().value!);
      this.states.set(id, { target: current, space, nodes, expiresAt: performance.now() + 15000 });
      return { observation: { id, target: current, region: space.region, topologyVersion: current.topologyVersion!, width, height,
        elements: projectChromeNodes(nodes),
        targetAppIsForeground: typeof ownership.targetAppIsForeground === "boolean" ? ownership.targetAppIsForeground : null,
        targetWindowIsForeground: typeof ownership.targetWindowIsForeground === "boolean" ? ownership.targetWindowIsForeground : null },
      image: { mimeType: "image/png", data: image.toPNG().toString("base64") }, browser: await this.metadata() };
    }
    const state = this.states.get(String(action.params.frameId ?? action.params.stateId));
    if (!state || state.expiresAt <= performance.now()) throw new CuaControlError("observation_stale");
    const current = await this.resolveTarget(target, signal);
    if (current.topologyVersion !== state.target.topologyVersion) throw new CuaControlError("observation_stale");
    if (action.method === "type_text") {
      const focused = await readFocusedChromeInput(this.send, signal);
      if (!focused || focused.secure || !focused.editable) {
        throw new CuaControlError("not_authorized", "Ordinary text requires a focused unprotected field.");
      }
    }
    if (action.method === "activate_window" || action.method === "element_action") throw new CuaControlError("unsupported_action", "Use observed page coordinates. Browser activation requires human takeover.");
    this.unsettled++;
    let dispatched = false;
    const checkedSend: ChromeSend = async (method, params, inputSignal) => {
      if (!this.active || request.epoch !== this.epoch) throw new CuaControlError("canceled");
      inputSignal?.throwIfAborted();
      await this.requireControl();
      // Once sent, cancellation cannot prove that Chrome did not process the input.
      dispatched = true;
      return this.send(method, params, inputSignal);
    };
    try {
      if (["request_credential", "type_credential"].includes(action.method)) {
        const binding = await verifyChromePassword(this.send, state, Number(action.params.elementIndex), signal);
        if (action.method === "request_credential") {
          if (binding.origin !== action.params.origin) throw new CuaControlError("not_authorized");
          const result = await this.native.chromeCredentialUi({ mode: "request", target: this.privateTarget(), binding, epoch: this.epoch }, signal);
          this.credential = { binding, epoch: this.epoch };
          return result;
        }
        const privateResult = await this.native.chromeCredentialUi({ mode: "take", target: this.privateTarget(), binding,
          epoch: this.epoch, credentialId: action.params.credentialId }, signal);
        this.credential = undefined;
        if (typeof privateResult.secret !== "string") throw new CuaControlError("not_authorized");
        try {
          await verifyChromePassword(this.send, state, Number(action.params.elementIndex), signal);
          await checkedSend("Input.insertText", { text: privateResult.secret }, signal);
        } finally { privateResult.secret = undefined; }
        return { status: "dispatched", effectVerified: false, credentialConsumed: true, inputBackend: "normal-chrome-page", inputRouting: "background" };
      }
      const result: ControlResult = await dispatchChromeInput(request, checkedSend, signal);
      const point = action.method === "drag" ? request.endPoint : request.point;
      if (["click", "move", "drag"].includes(action.method) && point && this.physical?.region && state.space.displayScale) {
        const { appId, pid, instanceId, windowId, region, topologyVersion } = this.physical;
        result.operationPointerReceipt = { target: { appId, pid, instanceId, windowId }, region, topologyVersion,
          space: "page", page: { version: state.space.version, region: state.space.region, scale: state.space.displayScale }, ...point,
          kind: "pointer", phase: action.method === "click" ? "click" : action.method === "drag" ? "drag" : "position", updatedAt: Date.now() };
      }
      return result;
    } catch (error) {
      console.warn("[computer-use] Scoped input failed", { method: action.method,
        code: error instanceof CuaControlError ? error.code :
          error instanceof DOMException && error.name === "TimeoutError" ? "backend_timeout" : "input_failed", dispatched });
      if (dispatched) { await this.failInput(); throw new CuaControlError("execution_uncertain"); }
      throw error;
    }
    finally { this.unsettled--; }
  }

  private privateTarget() {
    if (!this.physical) throw new CuaControlError("target_changed");
    const { appId, pid, instanceId, windowId } = this.physical;
    return { appId, pid, instanceId, windowId };
  }
  private async clearCredential() {
    this.credential = undefined;
    await this.native.chromeCredentialUi({ mode: "clear" });
  }
  async credentialUiStatus() {
    if (this.credential) {
      try {
        const current = await readChromeSpace(this.send);
        if (!String(this.credential.binding.field).startsWith(`${current.document}:`)) await this.clearCredential();
      } catch { await this.clearCredential(); }
    }
    return await this.native.chromeCredentialUi({ mode: "status" }) as { status: "none" | "pending" | "ready"; origin?: string };
  }
  async focusCredentialUi(origin: string, epoch: number) {
    if (!this.credential || this.credential.epoch !== epoch || this.credential.binding.origin !== origin || !this.active) throw new CuaControlError("not_authorized");
    await this.native.chromeCredentialUi({ mode: "focus", target: this.privateTarget(), binding: this.credential.binding, epoch });
  }
  private async metadata() {
    const credential = await this.credentialUiStatus();
    return { origin: this.space?.origin, browserName: "Google Chrome", credentialStatus: credential.status, coordinateSpace: "page-css" };
  }
  async preview() {
    const before = await readChromeSpace(this.send);
    const frame = await this.native.previewChromeUi(await this.mapWindow());
    const after = await readChromeSpace(this.send);
    const parsed = computerUsePreviewFrameGeometrySchema.safeParse(frame.previewFrameGeometry);
    if (parsed.success && before.version === after.version && before.displayScale === after.displayScale && after.displayScale) {
      frame.previewFrameGeometry = { ...parsed.data, page: { version: after.version, region: after.region, scale: after.displayScale } };
    } else delete frame.previewFrameGeometry;
    return frame;
  }
  async control(mode: "show" | "handover" | "background") {
    if (this.unsettled || this.uncertain) throw new CuaControlError("execution_uncertain");
    return this.native.chromeWindowUi(await this.mapWindow(), mode);
  }
  async stop() {
    this.active = false;
    this.leaseGeneration++;
    this.revokedEpoch = Math.max(this.revokedEpoch, this.epoch);
    this.epoch++;
    this.states.clear();
    if (this.unsettled) await this.failInput();
    else await this.clearCredential().catch(() => {});
  }
  private async failInput() { this.uncertain = true; this.active = false; await this.close(); }
  async close() {
    if (this.closing) return this.closing;
    this.active = false;
    this.leaseGeneration++;
    this.closing = (async () => {
      this.removeTargetListener?.();
      await Promise.all([this.clearCredential().catch(() => {}), this.pipe?.close()]);
      this.states.clear();
    })();
    return this.closing;
  }
}
