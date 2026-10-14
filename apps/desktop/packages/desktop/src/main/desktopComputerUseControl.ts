import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { app, dialog, type BrowserWindow } from "electron";
import { CuaControlAuthority, type ControlRequest, type ControlResult } from "@fcode/cua/control-authority";
import { CuaInvocationRegistry, type InvocationScope } from "@fcode/cua/invocation-registry";
import { CuaNativeSession } from "@fcode/cua/native-session/node";
import { CUA_LIMITS, CuaControlError, controlErrorDetails, isInputMethod, type ControlMethod, type ControlTarget } from "@fcode/cua/control-contract";
import {
  computerUseHostCommandSchema, computerUseIntentRequestSchema,
  FCODE_CUA_PRODUCT_HELPER_ENV_KEY, PlatformChannels,
  type ComputerUseHostCommand, type ComputerUseHostResult, type ComputerUseIntentRequest, type ComputerUsePanelRequest,
} from "@fcode/shared";
import { resolveCuaOsSupport } from "./cuaOsSupport.js";
import { DesktopComputerUsePanel } from "./desktopComputerUsePanel.js";
import { DesktopComputerUseCredentialUi } from "./desktopComputerUseCredentialUi.js";
import { computerUseWindowBackend, openComputerUseApplication } from "./desktopComputerUseApplication.js";
import { DesktopComputerUseChrome } from "./desktopComputerUseChrome.js";
import { resolveComputerUseHelperResource, requireComputerUseHelperResource } from "./desktopComputerUseResources.js";
import { closeComputerUseBackends } from "./desktopComputerUseCleanup.js";
import { validateComputerUseAction } from "@fcode/cua/desktop-contract";
import { executeMacDesktopAction } from "./desktopMacDesktopRoute.js";
import { createMacDesktopUi } from "./desktopComputerUseDesktopUi.js";
import { projectComputerUseOperation, stopComputerUseFailure } from "./desktopComputerUseTaskLifecycle.js";
import { handleComputerUseLeaseFailure } from "./desktopComputerUseLeaseFailure.js";

const APPROVED_METHODS: ControlMethod[] = ["open_browser", "open_application", "list_windows", "capture", "get_app_state", "activate_window",
  "click", "move", "drag", "scroll", "type_text", "request_credential", "type_credential", "press_keys", "element_action"];
const PRIVACY_VERSION = 1;

/** GUI Main owns the native child and the live authorization boundary. Nothing starts on construction. */
export function createDesktopComputerUseControl(options: {
  helperResourceRoot: string;
  getWindow(ownerId: string): BrowserWindow | undefined;
}) {
  let enabled: boolean | undefined;
  let native: CuaNativeSession | undefined;
  let nativeReady: Promise<CuaNativeSession> | undefined;
  let chrome: DesktopComputerUseChrome | undefined;
  let chromeReady: Promise<DesktopComputerUseChrome> | undefined;
  let windowTarget: ControlTarget | undefined;
  let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
  const clearLeaseHeartbeat = () => { clearInterval(leaseHeartbeat); leaseHeartbeat = undefined; };
  const desktop = createMacDesktopUi((ownerId) => requireWindow(ownerId));
  const grants = new Set<string>();
  const settingsPath = () => join(app.getPath("userData"), "computer-use-settings.json");
  const readEnabled = async () => {
    if (enabled !== undefined) return enabled;
    try {
      const value = JSON.parse(await readFile(settingsPath(), "utf8"));
      enabled = value.enabled === true && value.privacyVersion === PRIVACY_VERSION;
    } catch { enabled = false; }
    authority.setEnabled(enabled);
    return enabled;
  };
  const requireWindow = (ownerId: string) => {
    const win = options.getWindow(ownerId);
    if (!win || win.isDestroyed()) throw new CuaControlError("canceled", "The originating FCode window is closed.");
    return win;
  };
  const ensureNative = async (ownerId: string, signal: AbortSignal, beforePermissions: () => void) => {
    signal.throwIfAborted();
    if (!(await readEnabled())) throw new CuaControlError("not_authorized");
    if (nativeReady) return nativeReady;
    nativeReady = (async () => {
      if (process.platform !== "darwin" || resolveCuaOsSupport().kind !== "supported") {
        throw new CuaControlError("platform_unsupported", "Computer Use requires macOS 14 or later.");
      }
      const executablePath = requireComputerUseHelperResource({ root: options.helperResourceRoot,
        packaged: app.isPackaged, platform: process.platform, arch: process.arch });
      const session = new CuaNativeSession({ executablePath, inputRouting: "background" });
      native = session;
      let status = await session.status();
      if (![3, 4].includes(status.protocolVersion) || !status.axBatchObservation || !status.applicationWindowUi || !status.applicationLaunch || !status.normalBrowserUi || !status.credentialInput || !status.controlUi || !status.inputRoutings.includes("background")) {
        throw new CuaControlError("backend_unavailable", "The running Helper lacks compatible background input routing.");
      }
      if (status.screenLocked) throw new CuaControlError("desktop_locked", "Unlock the Mac and start a new Computer Use task.");
      if (!status.accessibility || !status.screenRecording) {
        beforePermissions();
        const response = await dialog.showMessageBox(requireWindow(ownerId), {
          type: "info", title: "Computer Use permissions", buttons: ["Continue", "Cancel"], cancelId: 1, signal,
          message: "Allow accessibility and screen recording for Computer Use.",
          detail: "macOS may open System Settings. Only selected windows or an explicitly confirmed desktop will be observed and controlled.",
        });
        if (response.response !== 0) throw new CuaControlError("not_authorized");
        signal.throwIfAborted();
        status = await session.requestPermissions({ accessibility: true, screenRecording: true }, signal);
      }
      if (!status.accessibility || !status.screenRecording) {
        throw new CuaControlError("permission_required", "Enable accessibility and screen recording in System Settings, then retry.");
      }
      return session;
    })().catch(async (error) => {
      await native?.close();
      native = undefined;
      nativeReady = undefined;
      throw error;
    });
    return nativeReady;
  };
  const authority = new CuaControlAuthority({
    consumeObservations: true,
    now: () => performance.now(), createId: randomUUID,
    isDenied: (target) => target.pid === process.pid ||
      (target.appId === "com.google.Chrome" && !chrome?.owns(target)),
    resolveTarget: (target, signal) => {
      if (!native) throw new CuaControlError("backend_unavailable");
      return chrome?.owns(target) ? chrome.resolveTarget(target, signal) : native.resolveTarget(target, signal);
    },
    requestApproval: async (request, signal) => {
      signal.throwIfAborted();
      const call = currentCalls.get(request.callId);
      if (!call) throw new CuaControlError("not_authorized");
      requireWindow(call.ownerId);
      const target = request.target;
      if (!target || !grants.has(JSON.stringify([request.context.sessionId, request.context.turnId,
        target.appId, target.pid, target.instanceId]))) throw new CuaControlError("not_authorized");
      // Task application consent covers input; each action still passes the authority's live checks.
      return "allow";
    },
    execute: async (request: ControlRequest, signal) => {
      if (!native) throw new CuaControlError("backend_unavailable");
      try {
        if (request.action.method === "open_browser" && !chrome) throw new CuaControlError("backend_unavailable");
        return chrome?.owns(request.target ?? request.action.params) ?
          await chrome.execute(request, signal) : await native.execute(request, signal) as ControlResult;
      }
      catch (error) {
        // Synchronize Main authority with Native stop before any subsequent lease.
        await authority.stop().catch(() => {});
        throw error;
      }
    },
    stop: async () => { clearLeaseHeartbeat(); desktop.clear(); await Promise.all([chrome?.stop(), native?.stop()]); },
  });
  const currentCalls = new Map<string, { ownerId: string; sessionId: string; turnId: string; cancellation: AbortController }>();
  const credentialUi = new DesktopComputerUseCredentialUi({
    isActive: (owner) => registry.isTurnActive(owner),
    publish: (ownerId, state) => {
      const win = options.getWindow(ownerId);
      if (win && !win.isDestroyed()) win.webContents.send(PlatformChannels.ComputerUseCredentialUiChanged, state);
    },
  });
  const panel = new DesktopComputerUsePanel({
    isActive: (owner) => registry.isTurnActive(owner),
    pointerDiagnostic: process.env.FCODE_CUA_POINTER_DIAGNOSTICS === "1"
      ? (code) => console.info(`[computer-use-pointer] ${code}`) : undefined,
    publish: (ownerId, state) => {
      const win = options.getWindow(ownerId);
      if (win && !win.isDestroyed()) win.webContents.send(PlatformChannels.ComputerUsePanelChanged, state);
    },
  });
  const closeNative = async () => {
    desktop.clear();
    const closing = native;
    const closingChrome = chrome;
    chrome = undefined; chromeReady = undefined;
    windowTarget = undefined;
    native = undefined; nativeReady = undefined;
    await closeComputerUseBackends(closingChrome, closing);
  };
  const registry = new CuaInvocationRegistry({
    now: () => performance.now(), createId: randomUUID,
    registerTurn: (context) => authority.registerTurn(context),
    registerCall: (sessionId, turnId) => authority.registerCall(sessionId, turnId),
    closeCall: (callId) => {
      currentCalls.get(callId)?.cancellation.abort(new CuaControlError("canceled"));
      currentCalls.delete(callId); authority.closeCall(callId);
    },
    closeTurn: (sessionId, turnId) => {
      credentialUi.closeTurn(sessionId, turnId);
      panel.closeTurn(sessionId, turnId);
      for (const key of grants) if (JSON.parse(key)[0] === sessionId && JSON.parse(key)[1] === turnId) grants.delete(key);
      const stopped = authority.closeTurn(sessionId, turnId);
      void Promise.resolve(stopped).then(async () => {
        if (authority.state.status === "idle" && currentCalls.size === 0 && !panel.isRetained()) {
          await closeNative();
        }
      });
    },
  });
  const control = {
    getPanel(ownerId: string) { return panel.getState(ownerId); },
    panelAction(ownerId: string, request: ComputerUsePanelRequest) {
      const win = requireWindow(ownerId);
      if (request.action === "preview" && (!win.isVisible() || win.isMinimized())) return Promise.resolve(panel.getState(ownerId));
      if (["pause", "handover", "stop"].includes(request.action)) console.info(`[computer-use] User control: ${request.action}`);
      return panel.request(ownerId, request);
    },
    getCredentialUi(ownerId: string) { return credentialUi.getState(ownerId); },
    focusCredentialUi(ownerId: string, sessionId: string) { return credentialUi.focus(ownerId, sessionId); },
    capabilityEnv(): Record<string, string> {
      const available = resolveCuaOsSupport().kind === "supported" && resolveComputerUseHelperResource({
        root: options.helperResourceRoot, packaged: app.isPackaged, platform: process.platform, arch: process.arch });
      return { [FCODE_CUA_PRODUCT_HELPER_ENV_KEY]: available ? "1" : "0" };
    },
    async prepareIntent(ownerId: string, value: ComputerUseIntentRequest): Promise<{ token: string }> {
      const input = computerUseIntentRequestSchema.parse(value);
      requireComputerUseHelperResource({ root: options.helperResourceRoot, packaged: app.isPackaged, platform: process.platform, arch: process.arch });
      if (!(await readEnabled())) {
        const response = await dialog.showMessageBox(requireWindow(ownerId), {
          type: "question", title: "Enable Computer Use", buttons: ["Enable and continue", "Cancel"], cancelId: 1,
          message: "Computer Use can observe and operate your real applications, mouse and keyboard.",
          detail: "When using a cloud model, selected window screenshots and interface content are sent to that model. Enable the plugin and select Computer Use for each task. You can stop or disable it at any time.",
        });
        if (response.response !== 0) throw new CuaControlError("not_authorized");
        enabled = true;
        await writeFile(settingsPath(), JSON.stringify({ enabled: true, privacyVersion: PRIVACY_VERSION }), { mode: 0o600 });
        authority.setEnabled(true);
      }
      return { token: registry.prepareIntent({ ownerId, ...input }) };
    },
    async handleHostCommand(scope: Omit<InvocationScope, "workspaceKey">, raw: ComputerUseHostCommand): Promise<ComputerUseHostResult> {
      try {
        const command = computerUseHostCommandSchema.parse(raw);
        if (command.kind === "register-invocation") {
          if (!(await readEnabled())) throw new CuaControlError("not_authorized");
          registry.consumeIntent({ ...scope, ...command });
        } else if (command.kind === "operation-event") {
          projectComputerUseOperation(panel, registry, scope, command, { stop: async () => { await authority.stop(); }, close: closeNative });
        } else if (command.kind === "cancel-call") {
          registry.closeToolCall({ ...scope, ...command.context });
        } else if (command.kind === "disable") {
          await control.setEnabled(false);
        } else {
          return { ok: true, result: await control.execute({ ...scope, workspaceKey: command.context.workspaceKey }, command.context, command.action) };
        }
        return { ok: true };
      } catch (error) {
        if (raw.kind === "execute-control") await stopComputerUseFailure(panel, registry, { ...scope, ...raw.context }, error,
          async () => { await authority.stop().catch(() => {}); await closeNative(); });
        return { ok: false, error: { code: error instanceof CuaControlError ? error.code : "invalid_request",
          message: error instanceof CuaControlError ? error.message : "Invalid Computer Use request.",
          ...controlErrorDetails(error) } };
      }
    },
    async execute(scope: InvocationScope, context: { sessionId: string; turnId: string; toolCallId: string; runtimeScope: string }, rawAction: unknown, signal?: AbortSignal) {
      const owner = { ...scope, ...context };
      panel.assertAllowed(owner);
      const call = registry.resolveCall(owner);
      let pending = currentCalls.get(call.callId);
      if (!pending) {
        pending = { ownerId: scope.ownerId, sessionId: context.sessionId, turnId: context.turnId, cancellation: new AbortController() };
        currentCalls.set(call.callId, pending);
      }
      signal = AbortSignal.any([pending.cancellation.signal, AbortSignal.timeout(CUA_LIMITS.callTtlMs), ...(signal ? [signal] : [])]);
      signal.throwIfAborted();
      const action = validateComputerUseAction(rawAction, "darwin");
      if (desktop.active && action.schemaVersion === 1 && action.method !== "list_apps") throw new CuaControlError("unsupported_action", "Use computer.desktop for this desktop task.");
      const retained = panel.isRetained();
      if (retained && (!panel.matches(owner) || panel.getState(owner.ownerId).inputRouting === "foreground")) { panel.clear(); await closeNative(); }
      panel.stage(owner, "preparing");
      const session = await ensureNative(scope.ownerId, signal, () => panel.stage(owner, "waiting_permission"));
      const windowBackend = computerUseWindowBackend(session, () => chrome, () => windowTarget);
      if (panel.isRetained() && panel.matches(owner) && action.schemaVersion === 1) {
        if (session.state.uncertain || chrome?.state.uncertain) throw new CuaControlError("execution_uncertain", "The previous input result is unknown. Stop and start a new task.");
        await windowBackend.control("background");
      }
      registry.resolveCall(owner);
      panel.begin(owner, {
        ...windowBackend,
        stop: async () => {
          credentialUi.clear();
          const stopped = authority.stop();
          for (const call of currentCalls.values()) {
            if (call.sessionId === owner.sessionId && call.turnId === owner.turnId) call.cancellation.abort(new CuaControlError("canceled"));
          }
          await stopped;
        },
        close: async () => { if (native === session) await closeNative(); },
      });
      if (action.method === "open_browser") {
        if (!chromeReady) chromeReady = DesktopComputerUseChrome.start(session,
          join(app.getPath("userData"), "computer-use-browser"), signal).then((value) => {
          if (native !== session) { void value.close(); throw new CuaControlError("canceled"); }
          chrome = value; return value;
        }).catch((error) => { chromeReady = undefined; throw error; });
        const browser = await chromeReady;
        signal.throwIfAborted();
        action.params = { url: action.params.url, ...browser.application };
      }
      // Revalidate after permission UI or child startup; neither may revive a canceled call.
      registry.resolveCall({ ...scope, ...context });
      const previousLease = authority.state.lease;
      if (previousLease && previousLease.expiresAt <= performance.now()) await authority.stop();
      registry.resolveCall({ ...scope, ...context });
      panel.assertAllowed(owner);
      if (session.state.uncertain || chrome?.state.uncertain) {
        if (isInputMethod(action.method)) throw new CuaControlError("execution_uncertain");
        await authority.stop();
      } else {
        const lease = authority.acquire(call.callId);
        await session.lease(lease.epoch);
        if (chrome) await chrome.lease(lease.epoch);
        if (!desktop.active && action.schemaVersion === 1) await windowBackend.checkTarget();
        clearLeaseHeartbeat();
        const sameLease = () => native === session && authority.state.lease?.leaseId === lease.leaseId;
        const leaseFailed = (error: unknown) => handleComputerUseLeaseFailure({ error, desktop: desktop.active, panel, owner, current: sameLease,
          status: () => session.status(), stop: async () => { await authority.stop(); }, diagnostic: (value) => console.warn("[computer-use] Lease stopped:", value),
        }).catch(() => { if (sameLease()) void authority.stop(); });
        leaseHeartbeat = setInterval(() => {
          try {
            if (!sameLease()) return;
            if (!registry.isTurnActive({ ...scope, ...context })) throw new CuaControlError("not_authorized");
            panel.assertAllowed(owner);
            authority.heartbeatTurn(context.sessionId, context.turnId, lease.leaseId);
            void Promise.all([session.lease(lease.epoch), chrome?.lease(lease.epoch), desktop.active ? session.status().then((status) => { if (status.desktopInterrupted) throw new CuaControlError("canceled"); }) : windowBackend.checkTarget()]).catch(leaseFailed);
          } catch (error) { void leaseFailed(error); }
        }, CUA_LIMITS.heartbeatMs);
        leaseHeartbeat.unref();
      }
      const desktopLease = authority.state.lease;
      if (action.schemaVersion === 2 && !desktopLease) throw new CuaControlError("not_authorized");
      if (action.schemaVersion === 2) return executeMacDesktopAction({ desktop, panel, session, owner, action,
        callId: call.callId, epoch: desktopLease!.epoch, signal, stop: async () => { await authority.stop(); }, assertCurrent: () => {
          signal.throwIfAborted(); registry.resolveCall(owner); panel.assertAllowed(owner);
          if (native !== session || authority.state.lease?.epoch !== desktopLease!.epoch) throw new CuaControlError("canceled");
        } });
      if (action.method === "open_application") {
        const lease = authority.state.lease;
        if (!lease) throw new CuaControlError("not_authorized");
        const key = (target: { appId: string; pid: number; instanceId: string }) =>
          JSON.stringify([context.sessionId, context.turnId, target.appId, target.pid, target.instanceId]);
        action.params = await openComputerUseApplication({ native: session, appId: String(action.params.appId),
          epoch: lease.epoch, signal, window: requireWindow(scope.ownerId),
          assertCurrent: () => {
            signal.throwIfAborted(); registry.resolveCall(owner); panel.assertAllowed(owner);
            if (native !== session || authority.state.lease?.leaseId !== lease.leaseId) throw new CuaControlError("canceled");
          },
          isGranted: (target) => grants.has(key(target)),
          grant: (target) => { authority.grantApplication(call.callId, target, APPROVED_METHODS); grants.add(key(target)); },
        });
      }
      if (action.params.appId) {
        const target = chrome?.owns(action.params) ? await chrome.resolveTarget(action.params, signal) : await session.resolveTarget(action.params, signal);
        const grantKey = JSON.stringify([context.sessionId, context.turnId, target.appId, target.pid, target.instanceId]);
        if (!grants.has(grantKey)) {
          const response = await dialog.showMessageBox(requireWindow(scope.ownerId), {
            type: "question", title: "Allow application access", buttons: ["Allow for this task", "Deny"], cancelId: 1, signal,
            message: `Allow Computer Use to observe and control ${target.appId}?`,
            detail: "Allow observation, mouse and keyboard actions in this running application for this task. Ordinary actions will not ask again. This version operates supported controls in the background. Unsupported actions stop instead of taking over your mouse or keyboard. Stop the task to take control; task completion or cancellation revokes access.",
          });
          signal?.throwIfAborted();
          registry.resolveCall({ ...scope, ...context });
          panel.assertAllowed(owner);
          if (response.response !== 0) throw new CuaControlError("not_authorized", "Application access was declined for this task.");
          authority.grantApplication(call.callId, target, APPROVED_METHODS);
          grants.add(grantKey);
        }
      }
      panel.assertAllowed(owner);
      if (action.method === "open_browser" && chrome?.owns(action.params)) {
        panel.action(owner, action.method, false, { browser: { browserName: "Google Chrome" } });
      }
      panel.action(owner, action.method, true);
      let result: ControlResult;
      try { result = await authority.execute(call.callId, action, signal); }
      catch (error) { panel.clearPointer(owner); throw error; }
      finally { panel.action(owner, action.method, false); }
      const resultTarget = (result.target ?? (result.observation as { target?: ControlTarget } | undefined)?.target) as ControlTarget | undefined;
      if (resultTarget?.windowId) windowTarget = resultTarget;
      if (action.method === "list_apps") {
        const status = await session.status(signal);
        result.runtime = { platform: "darwin", desktop: { available: status.protocolVersion === 4 && status.desktopObservation === true && status.desktopInput === true && status.physicalEscapeTakeover === true } };
      }
      panel.action(owner, action.method, false, result);
      // Display-only backend receipts must never enter tool history or model screenshots.
      delete result.operationPointerReceipt;
      delete result.previewFrameGeometry;
      panel.assertAllowed(owner);
      if (action.method === "request_credential" && result.status === "pending" && typeof result.origin === "string") {
        registry.resolveCall({ ...scope, ...context });
        const owner = { ...scope, sessionId: context.sessionId, turnId: context.turnId, runtimeScope: context.runtimeScope };
        credentialUi.begin({ ...owner,
          read: () => chrome ? chrome.credentialUiStatus() : session.credentialUiStatus(),
          focus: async (origin) => {
            const lease = authority.state.lease;
            if (native !== session || !registry.isTurnActive(owner) || !lease ||
                lease.sessionId !== context.sessionId || lease.turnId !== context.turnId || session.state.uncertain || chrome?.state.uncertain) {
              throw new CuaControlError("not_authorized");
            }
            return chrome ? chrome.focusCredentialUi(origin, lease.epoch) : session.focusCredentialUi(origin, lease.epoch);
          },
        }, result.origin);
      }
      return result;
    },
    async setEnabled(value: boolean) {
      enabled = value === true;
      await authority.setEnabled(enabled);
      if (!enabled) { panel.clear(); credentialUi.clear(); registry.clear(); await closeNative(); grants.clear(); }
      await writeFile(settingsPath(), JSON.stringify({ enabled, privacyVersion: PRIVACY_VERSION }), { mode: 0o600 });
    },
    revokeHost(hostId: string) {
      registry.revokeHost(hostId);
      if (panel.isRetained() && panel.belongsToHost(hostId)) { panel.clear(); void closeNative(); }
    },
    revokeOwner(ownerId: string) {
      registry.revokeOwner(ownerId);
      if (panel.getState(ownerId).status !== "none") { panel.clear(); void closeNative(); }
    },
    async dispose() { panel.clear(); credentialUi.clear(); registry.clear(); await authority.setEnabled(false); await closeNative(); },
  };
  return control;
}
