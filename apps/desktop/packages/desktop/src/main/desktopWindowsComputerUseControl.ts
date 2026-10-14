import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CuaControlAuthority, type ControlResult } from "@fcode/cua/control-authority";
import { CuaInvocationRegistry, type InvocationScope } from "@fcode/cua/invocation-registry";
import type { CuaWindowsNativeSession } from "@fcode/cua/windows-native-session/node";
import { CUA_LIMITS, CuaControlError, type ControlMethod, type ControlTarget } from "@fcode/cua/control-contract";
import { computerUseHostCommandSchema, computerUseIntentRequestSchema, FCODE_CUA_PRODUCT_HELPER_ENV_KEY,
  type ComputerUseHostCommand, type ComputerUseHostResult, type ComputerUseIntentRequest,
  type ComputerUsePanelRequest, type ComputerUsePanelState, type ComputerUseCredentialUiState } from "@fcode/shared";
import { DesktopComputerUsePanel, type PanelOwner } from "./desktopComputerUsePanel.js";
import { validateComputerUseAction } from "@fcode/cua/windows-desktop-contract";
import { WindowsDesktopRoute } from "./desktopWindowsDesktopRoute.js";
import { projectComputerUseOperation } from "./desktopComputerUseTaskLifecycle.js";
import type { WindowsControlFailureStage } from "./desktopWindowsComputerUseFailureDiagnostic.js";

type Native = Pick<CuaWindowsNativeSession, "state" | "status" | "lease" | "resolveTarget" | "execute" | "stop" | "close" |
  "previewApplicationUi" | "applicationWindowUi" | "desktopDisplays" | "desktopScope">;
type CallOwner = PanelOwner & { toolCallId: string };
const METHODS: ControlMethod[] = ["list_apps", "list_windows", "capture", "get_app_state", "click", "move", "scroll", "drag",
  "type_text", "press_keys", "element_action", "prepare_input"];
const APPROVED = METHODS.filter((method) => method !== "list_apps" && method !== "prepare_input");

function projectWindowsImage(method: ControlMethod, result: ControlResult): ControlResult {
  if (method !== "capture" && method !== "get_app_state") return result;
  const { images, ...summary } = result;
  if (!Array.isArray(images) || images.length !== 1 || "image" in summary) throw new CuaControlError("protocol_invalid");
  const png = images[0];
  if (!png || typeof png !== "object" || Array.isArray(png) ||
      Object.keys(png).length !== 2 || png.mimeType !== "image/png" ||
      typeof png.data !== "string" || !png.data.length || png.data.length > CUA_LIMITS.responseBytes) {
    throw new CuaControlError("protocol_invalid");
  }
  return { ...summary, image: { mimeType: png.mimeType, data: png.data } };
}

export interface WindowsComputerUsePorts {
  hostPid: number;
  available(): boolean;
  window(ownerId: string): { visible: boolean; minimized: boolean } | undefined;
  readEnabled(): Promise<boolean>;
  writeEnabled(enabled: boolean): Promise<void>;
  approve(ownerId: string, request: { kind: "enable" | "application" | "desktop"; target?: ControlTarget; displayId?: string }, signal?: AbortSignal): Promise<boolean>;
  prepareDesktop?(ownerId: string): Promise<void>;
  startNative(signal: AbortSignal): Promise<Native>;
  publish(ownerId: string, state: ComputerUsePanelState): void;
  diagnoseFailure?(stage: WindowsControlFailureStage, error: unknown): void;
}

/** Windows-only lifecycle. Construction starts no child, timer, settings read or OS probe. */
export function createWindowsComputerUseController(ports: WindowsComputerUsePorts) {
  let enabled: boolean | undefined;
  let settingsReady: Promise<boolean> | undefined;
  let native: Native | undefined;
  let nativeReady: Promise<Native> | undefined;
  let generation = 0;
  let target: ControlTarget | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const grants = new Set<string>();
  const calls = new Map<string, { owner: CallOwner; cancellation: AbortController }>();
  const desktop = new WindowsDesktopRoute({
    approve: (owner, displayId, signal) => ports.approve(owner.ownerId, { kind: "desktop", displayId }, signal),
    prepare: (owner) => ports.prepareDesktop?.(owner.ownerId) ?? Promise.resolve(),
  });
  const requireWindow = (id: string) => {
    const window = ports.window(id);
    if (!window) throw new CuaControlError("canceled", "The originating FCode window is closed.");
    return window;
  };
  const grantKey = (owner: { sessionId: string; turnId: string }, value: ControlTarget) =>
    JSON.stringify([owner.sessionId, owner.turnId, value.appId, value.pid, value.instanceId]);
  const clearHeartbeat = () => { clearInterval(heartbeat); heartbeat = undefined; };
  const closeNative = async () => {
    generation++;
    clearHeartbeat();
    const closing = native;
    native = undefined; nativeReady = undefined; target = undefined;
    desktop.clear();
    await closing?.close();
  };
  const assertCall = (callId: string) => {
    const pending = calls.get(callId);
    if (!pending || registry.resolveCall(pending.owner).callId !== callId) throw new CuaControlError("not_authorized");
    requireWindow(pending.owner.ownerId); panel.assertAllowed(pending.owner);
    pending.cancellation.signal.throwIfAborted();
    return pending.owner;
  };
  const authority = new CuaControlAuthority({
    now: () => performance.now(), createId: randomUUID,
    isDenied: (value) => value.pid === ports.hostPid,
    resolveTarget: (value, signal) => {
      if (!native) throw new CuaControlError("backend_unavailable");
      return native.resolveTarget(value, signal);
    },
    requestApproval: async (request, signal) => {
      signal.throwIfAborted();
      const owner = assertCall(request.callId);
      if (!request.target || !grants.has(grantKey(owner, request.target))) throw new CuaControlError("not_authorized");
      return "allow";
    },
    execute: async (request, signal) => {
      const session = native;
      if (!session) throw new CuaControlError("backend_unavailable");
      try {
        const result = await session.execute(request, signal, () => {
          assertCall(request.callId);
          if (native !== session) throw new CuaControlError("canceled");
        });
        return projectWindowsImage(request.action.method, result);
      } catch (error) {
        await authority.stop().catch(() => {});
        throw error;
      }
    },
    stop: async () => { clearHeartbeat(); desktop.clear(); await native?.stop(); },
  });
  const panel = new DesktopComputerUsePanel({ isActive: (owner) => registry.isTurnActive(owner), publish: ports.publish });
  const registry = new CuaInvocationRegistry({
    now: () => performance.now(), createId: randomUUID,
    registerTurn: (context) => authority.registerTurn(context),
    registerCall: (sessionId, turnId) => authority.registerCall(sessionId, turnId),
    closeCall: (callId) => {
      calls.get(callId)?.cancellation.abort(new CuaControlError("canceled"));
      calls.delete(callId); authority.closeCall(callId);
    },
    closeTurn: (sessionId, turnId) => {
      panel.closeTurn(sessionId, turnId);
      for (const key of grants) {
        const binding = JSON.parse(key);
        if (binding[0] === sessionId && binding[1] === turnId) grants.delete(key);
      }
      void Promise.resolve(authority.closeTurn(sessionId, turnId)).then(async () => {
        if (authority.state.status === "idle" && calls.size === 0 && !panel.isRetained()) await closeNative();
      }).catch(() => { void closeNative().catch(() => {}); });
    },
  });
  const readEnabled = async () => {
    if (enabled !== undefined) return enabled;
    if (!settingsReady) {
      const captured = generation;
      settingsReady = ports.readEnabled().then(async (value) => {
        if (captured !== generation) throw new CuaControlError("canceled");
        enabled = value === true; await authority.setEnabled(enabled); return enabled;
      }).finally(() => { settingsReady = undefined; });
    }
    return settingsReady;
  };
  const ensureNative = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!ports.available()) throw new CuaControlError("backend_unavailable", "Windows Computer Use resources have not passed acceptance.");
    if (!(await readEnabled())) throw new CuaControlError("not_authorized");
    if (nativeReady) return nativeReady;
    const captured = generation;
    const starting = ports.startNative(signal).then(async (session) => {
      try {
        signal.throwIfAborted();
        if (captured !== generation || !enabled) throw new CuaControlError("canceled");
        const status = await session.status(signal);
        signal.throwIfAborted();
        if (captured !== generation || !enabled) throw new CuaControlError("canceled");
        if (status.platform !== "win32" || status.hostRole !== "electron-main" || status.arch !== "x64" || status.osBuild < 22000 ||
          ["win32-window-messages", "uia-observation", "application-window-ui", "desktop-lease-journal"].some((capability) =>
            !status.capabilities.includes(capability as typeof status.capabilities[number]))) throw new CuaControlError("backend_unavailable");
        if (!status.interactiveDesktop) throw new CuaControlError("desktop_locked");
        native = session; return session;
      } catch (error) { await session.close(); throw error; }
    });
    nativeReady = starting;
    void starting.catch((error) => {
      ports.diagnoseFailure?.("native-start", error);
      if (nativeReady === starting) nativeReady = undefined;
    });
    return starting;
  };
  const windowBackend = (session: Native) => ({
    checkTarget: async () => { if (target) await session.applicationWindowUi(target, "read"); },
    preview: async () => {
      if (!target) throw new CuaControlError("target_unavailable");
      const frame = await session.previewApplicationUi(target);
      const image = frame.image as { mimeType: string; data: string } | undefined;
      if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") throw new CuaControlError("protocol_invalid");
      return { image, previewFrameGeometry: frame.previewFrameGeometry };
    },
    control: async (mode: "show" | "handover" | "background") => {
      if (!target) throw new CuaControlError("target_unavailable");
      return session.applicationWindowUi(target, mode);
    },
  });
  const control = {
    capabilityEnv(): Record<string, string> { return { [FCODE_CUA_PRODUCT_HELPER_ENV_KEY]: ports.available() ? "1" : "0" }; },
    getPanel(ownerId: string) { return panel.getState(ownerId); },
    panelAction(ownerId: string, request: ComputerUsePanelRequest) {
      const window = requireWindow(ownerId);
      if (request.action === "preview" && (!window.visible || window.minimized)) return Promise.resolve(panel.getState(ownerId));
      return panel.request(ownerId, request);
    },
    getCredentialUi(_ownerId: string): ComputerUseCredentialUiState { return { sessionId: null, status: "none" }; },
    async focusCredentialUi(_ownerId: string, _sessionId: string): Promise<void> { throw new CuaControlError("unsupported_action"); },
    async prepareIntent(ownerId: string, raw: ComputerUseIntentRequest): Promise<{ token: string }> {
      const input = computerUseIntentRequestSchema.parse(raw);
      requireWindow(ownerId);
      if (!ports.available()) throw new CuaControlError("backend_unavailable", "Windows Computer Use resources have not passed acceptance.");
      if (!(await readEnabled())) {
        const captured = generation;
        if (!(await ports.approve(ownerId, { kind: "enable" }))) throw new CuaControlError("not_authorized");
        requireWindow(ownerId);
        if (captured !== generation) throw new CuaControlError("canceled");
        await control.setEnabled(true);
      }
      return { token: registry.prepareIntent({ ownerId, ...input }) };
    },
    async handleHostCommand(scope: Omit<InvocationScope, "workspaceKey">, raw: ComputerUseHostCommand): Promise<ComputerUseHostResult> {
      let stage: WindowsControlFailureStage = "host-schema";
      try {
        requireWindow(scope.ownerId);
        const command = computerUseHostCommandSchema.parse(raw);
        stage = command.kind === "execute-control" ? "host-execute" : "host-operation";
        if (command.kind === "register-invocation") {
          if (!(await readEnabled())) throw new CuaControlError("not_authorized");
          registry.consumeIntent({ ...scope, ...command });
        } else if (command.kind === "operation-event") {
          projectComputerUseOperation(panel, registry, scope, command, { stop: async () => { await authority.stop(); }, close: closeNative });
        }
        else if (command.kind === "cancel-call") registry.closeToolCall({ ...scope, ...command.context });
        else if (command.kind === "disable") await control.setEnabled(false);
        else return { ok: true, result: await control.execute({ ...scope, workspaceKey: command.context.workspaceKey }, command.context, command.action) };
        return { ok: true };
      } catch (error) {
        ports.diagnoseFailure?.(stage, error);
        return { ok: false, error: { code: error instanceof CuaControlError ? error.code : "invalid_request",
          message: error instanceof CuaControlError ? error.message : "Invalid Computer Use request." } };
      }
    },
    async execute(scope: InvocationScope, context: { sessionId: string; turnId: string; toolCallId: string; runtimeScope: string }, raw: unknown) {
      const owner = { ...scope, ...context };
      requireWindow(owner.ownerId); panel.assertAllowed(owner);
      const call = registry.resolveCall(owner);
      const action = validateComputerUseAction(raw, "win32");
      const intended = action.method === "prepare_input" ? action.params.method as ControlMethod : action.method;
      if (action.schemaVersion === 1 && (!METHODS.includes(intended as ControlMethod) || (desktop.active && intended !== "list_apps"))) {
        throw new CuaControlError("unsupported_action", "Use the explicitly selected desktop route for this task.");
      }
      let pending = calls.get(call.callId);
      if (!pending) { pending = { owner, cancellation: new AbortController() }; calls.set(call.callId, pending); }
      const signal = AbortSignal.any([pending.cancellation.signal, AbortSignal.timeout(CUA_LIMITS.callTtlMs)]);
      // A paused desktop retains pixels, not a background application target or an input scope.
      // assertAllowed and the invocation registry already require a newly selected human turn.
      if (panel.isRetained() && (!panel.matches(owner) || panel.getState(owner.ownerId).inputRouting === "foreground")) {
        panel.clear(); await closeNative();
      }
      const session = await ensureNative(signal);
      assertCall(call.callId);
      if (session.state.uncertain) throw new CuaControlError("execution_uncertain");
      const backend = windowBackend(session);
      if (panel.isRetained() && action.schemaVersion === 1) await backend.control("background");
      panel.begin(owner, { ...backend,
        stop: async () => {
          const stopped = authority.stop();
          for (const entry of calls.values()) {
            if (entry.owner.sessionId === owner.sessionId && entry.owner.turnId === owner.turnId) entry.cancellation.abort(new CuaControlError("canceled"));
          }
          await stopped;
        },
        close: async () => { if (native === session) await closeNative(); },
      });
      const previous = authority.state.lease;
      if (previous && previous.expiresAt <= performance.now()) await authority.stop();
      assertCall(call.callId);
      const lease = authority.acquire(call.callId);
      await session.lease(lease.epoch);
      assertCall(call.callId);
      clearHeartbeat();
      heartbeat = setInterval(() => {
        if (native !== session || authority.state.lease?.leaseId !== lease.leaseId) return;
        try {
          if (!registry.isTurnActive(owner)) throw new CuaControlError("not_authorized");
          requireWindow(owner.ownerId); panel.assertAllowed(owner);
          authority.heartbeatTurn(owner.sessionId, owner.turnId, lease.leaseId);
          void Promise.all([session.lease(lease.epoch), desktop.active ? session.status().then((status) => {
            if (status.desktopInterrupted) throw new CuaControlError("canceled");
          }) : backend.checkTarget()]).catch(() => {
            if (desktop.active) {
              void panel.request(owner.ownerId, { sessionId: owner.sessionId, action: "pause" }).catch(() => { void authority.stop(); });
            } else void authority.stop();
          });
        } catch { void authority.stop().catch(() => {}); }
      }, CUA_LIMITS.heartbeatMs);
      heartbeat.unref();
      if (action.schemaVersion === 2) {
        const status = await session.status(signal);
        if (!status.capabilities.includes("desktop-monitor-capture") || !status.capabilities.includes("win32-send-input")) {
          throw new CuaControlError("unsupported_action", "The native Helper has no interactive desktop capability.");
        }
        panel.action(owner, action.method, true, { inputRouting: "foreground" });
        try {
          const result = await desktop.execute({ owner, callId: call.callId, action, native: session, epoch: lease.epoch, signal,
            assertCurrent: () => { assertCall(call.callId); if (native !== session || authority.state.lease?.epoch !== lease.epoch) throw new CuaControlError("canceled"); } });
          panel.action(owner, action.method, false, result); return result;
        } catch (error) {
          desktop.invalidateFrame();
          // Held physical buttons/modifiers are a pre-dispatch conflict, not takeover intent.
          if (!(error instanceof CuaControlError) || !["observation_stale", "target_changed", "unsupported_action", "invalid_request", "control_busy"].includes(error.code)) {
            await authority.stop();
          }
          panel.clearPointer(owner); throw error;
        }
        finally { panel.action(owner, action.method, false); }
      }
      if (action.params.appId) {
        const resolved = await session.resolveTarget(action.params, signal);
        assertCall(call.callId);
        const key = grantKey(owner, resolved);
        if (!grants.has(key)) {
          if (!(await ports.approve(owner.ownerId, { kind: "application", target: resolved }, signal))) throw new CuaControlError("not_authorized");
          assertCall(call.callId); signal.throwIfAborted();
          const current = await session.resolveTarget(resolved, signal);
          assertCall(call.callId);
          if (grantKey(owner, current) !== key) throw new CuaControlError("target_changed");
          authority.grantApplication(call.callId, current, APPROVED); grants.add(key);
        }
      }
      assertCall(call.callId);
      panel.action(owner, action.method, true);
      let result: ControlResult;
      try { result = await authority.execute(call.callId, action, signal); }
      catch (error) { panel.clearPointer(owner); throw error; }
      finally { panel.action(owner, action.method, false); }
      assertCall(call.callId);
      const resultTarget = (result.target ?? result.observation?.target) as ControlTarget | undefined;
      if (resultTarget?.windowId) target = resultTarget;
      panel.action(owner, action.method, false, result);
      delete result.operationPointerReceipt; delete result.previewFrameGeometry;
      return result;
    },
    async setEnabled(value: boolean) {
      generation++; enabled = value === true;
      await authority.setEnabled(enabled);
      if (!enabled) { panel.clear(); registry.clear(); grants.clear(); await closeNative(); }
      await ports.writeEnabled(enabled);
    },
    revokeHost(hostId: string) {
      registry.revokeHost(hostId);
      if (panel.isRetained() && panel.belongsToHost(hostId)) { panel.clear(); void closeNative().catch(() => {}); }
    },
    revokeOwner(ownerId: string) {
      registry.revokeOwner(ownerId);
      if (panel.getState(ownerId).status !== "none") { panel.clear(); void closeNative().catch(() => {}); }
    },
    async dispose() { generation++; enabled = false; panel.clear(); registry.clear(); await authority.setEnabled(false); await closeNative(); },
  };
  return control;
}
