import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CUA_LIMITS, CuaControlError, assertRecord, assertString } from "@fcode/cua/control-contract";
import type { ControlResult } from "@fcode/cua/control-authority";
import { isDesktopInput, type DesktopAction } from "@fcode/cua/desktop-contract";
import type { PanelOwner } from "./desktopComputerUsePanel.js";

type Native = {
  desktopDisplays(signal?: AbortSignal): Promise<Record<string, unknown>>;
  desktopScope(id: string, displayId: string, epoch: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  execute(request: { action: DesktopAction; callId: string; epoch: number; revision: number; desktopScope: string },
    signal?: AbortSignal, assertCurrent?: () => void): Promise<Record<string, unknown>>;
};
type Frame = { id: string; width: number; height: number; expires: number };
const MAX_DESKTOP_ACTIONS = 512;
const MAX_OBSERVATION_ATTEMPTS = 3;
const OBSERVATION_BACKOFF_MS = 100;
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new CuaControlError("protocol_invalid");
  return value as number;
}
function region(value: unknown) {
  const r = assertRecord(value, ["x", "y", "width", "height"]);
  integer(r.x, -100_000, 100_000); integer(r.y, -100_000, 100_000);
  integer(r.width, 1, 100_000); integer(r.height, 1, 100_000); return r;
}

/** A real desktop scope never becomes an application target or application grant. */
export class DesktopRoute {
  private scope?: { id: string; key: string; displayId: string; epoch: number };
  private frame?: Frame;
  private actions = new Set<string>();
  private generation = 0;
  private transition: Promise<unknown> = Promise.resolve();
  constructor(private ports: {
    approve(owner: PanelOwner, displayId: string, signal: AbortSignal): Promise<boolean>;
    prepare(owner: PanelOwner): Promise<void>;
    beforeObserve?(owner: PanelOwner): Promise<void>;
  }, private platform: "darwin" | "win32" = "win32") {}
  get active() { return Boolean(this.scope); }
  invalidateFrame() { this.frame = undefined; }
  clear() { this.generation++; this.scope = undefined; this.frame = undefined; this.actions.clear(); }

  execute(input: { owner: PanelOwner; callId: string; action: DesktopAction; native: Native; epoch: number;
    signal: AbortSignal; assertCurrent(): void }): Promise<ControlResult> {
    const generation = this.generation;
    const assertCurrent = () => {
      input.assertCurrent();
      if (this.generation !== generation) throw new CuaControlError("canceled");
    };
    const run = this.transition.then(() => this.run({ ...input, assertCurrent }));
    this.transition = run.catch(() => undefined); return run;
  }
  private async run(input: Parameters<DesktopRoute["execute"]>[0]): Promise<ControlResult> {
    const { native, owner, epoch, action, signal, assertCurrent } = input;
    signal.throwIfAborted(); assertCurrent();
    const key = JSON.stringify([owner.ownerId, owner.hostId, owner.workspaceKey, owner.sessionId, owner.turnId]);
    if (this.scope && (this.scope.key !== key || this.scope.epoch !== epoch)) throw new CuaControlError("not_authorized");
    if (!this.scope) {
      if (action.method !== "desktop_get_state") throw new CuaControlError("observation_stale", "Observe the desktop before input.");
      const catalog = assertRecord(await native.desktopDisplays(signal), ["displays", "topologyVersion"]);
      assertString(catalog.topologyVersion, 128);
      if (!Array.isArray(catalog.displays) || !catalog.displays.length || catalog.displays.length > 32) throw new CuaControlError("protocol_invalid");
      const displays = catalog.displays.map((value: unknown) => {
        const display = assertRecord(value, ["displayId", "primary", "region"]);
        assertString(display.displayId, 128); region(display.region);
        if (typeof display.primary !== "boolean") throw new CuaControlError("protocol_invalid"); return display;
      });
      const primary = displays.filter((value) => value.primary);
      if (primary.length !== 1) throw new CuaControlError("protocol_invalid");
      const displayId = primary[0]!.displayId as string;
      if (action.params.displayId !== undefined && action.params.displayId !== displayId) throw new CuaControlError("not_authorized");
      assertCurrent();
      if (!(await this.ports.approve(owner, displayId, signal))) throw new CuaControlError("not_authorized");
      signal.throwIfAborted(); assertCurrent(); await this.ports.prepare(owner);
      signal.throwIfAborted(); assertCurrent();
      const id = randomUUID(); await native.desktopScope(id, displayId, epoch, signal);
      signal.throwIfAborted(); assertCurrent(); this.scope = { id, key, displayId, epoch };
    }
    const scope = this.scope;
    if (action.params.displayId !== undefined && action.params.displayId !== scope.displayId) throw new CuaControlError("not_authorized");
    if (this.actions.has(action.actionId)) throw new CuaControlError("not_authorized", "A desktop action cannot be replayed.");
    if (this.actions.size >= MAX_DESKTOP_ACTIONS) throw new CuaControlError("resource_limit");
    if (isDesktopInput(action.method)) {
      const frame = this.frame;
      if (!frame || frame.id !== action.params.frameId || frame.expires <= performance.now()) throw new CuaControlError("observation_stale");
      for (const field of ["x", "toX"]) if (field in action.params) integer(action.params[field], 0, frame.width - 1);
      for (const field of ["y", "toY"]) if (field in action.params) integer(action.params[field], 0, frame.height - 1);
      this.frame = undefined;
    }
    this.actions.add(action.actionId);
    const assertScoped = () => {
      signal.throwIfAborted();
      assertCurrent(); if (this.scope !== scope) throw new CuaControlError("canceled");
    };
    const observe = action.method === "desktop_get_state" && this.ports.beforeObserve;
    if (action.method === "desktop_get_state") this.frame = undefined;
    let result!: ControlResult;
    for (let attempt = 0; ; attempt++) {
      assertScoped();
      if (observe) {
        await observe(owner);
        assertScoped();
      }
      try {
        // Only observations can be retried, each with a new Native action ID.
        const next = attempt ? { ...action, actionId: randomUUID() } : action;
        result = await native.execute({ action: next, callId: input.callId, epoch, revision: 0, desktopScope: scope.id }, signal, assertScoped);
        break;
      } catch (error) {
        assertScoped();
        if (!observe || attempt + 1 >= MAX_OBSERVATION_ATTEMPTS || !(error instanceof CuaControlError) || error.requiresUserAction ||
            !["observation_stale", "control_busy"].includes(error.code)) throw error;
        await delay(OBSERVATION_BACKOFF_MS * (attempt + 1), undefined, { signal });
      }
    }
    assertScoped();
    if (action.method === "desktop_get_state") {
      assertRecord(result, ["image", "desktopObservation", "application", "frameId", "coordinateSpace", "inputRouting"]);
      const image = assertRecord(result.image, ["mimeType", "data"]);
      if (image.mimeType !== "image/png" || typeof image.data !== "string" || image.data.length > CUA_LIMITS.responseBytes ||
          !/^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new CuaControlError("protocol_invalid");
      const observation = assertRecord(result.desktopObservation, ["id", "displayId", "topologyVersion", "width", "height", "region", "capturedAtMs", "foreground"]);
      assertString(observation.id, 128); assertString(observation.topologyVersion, 128); region(observation.region);
      integer(observation.capturedAtMs, 1, Number.MAX_SAFE_INTEGER);
      const foreground = assertRecord(observation.foreground, ["title", "application"], []);
      for (const field of Object.keys(foreground)) if (typeof foreground[field] !== "string" || (foreground[field] as string).length > 1024) throw new CuaControlError("protocol_invalid");
      const application = assertRecord(result.application, ["name"]);
      if (application.name !== (this.platform === "darwin" ? "macOS desktop" : "Windows desktop") || observation.displayId !== scope.displayId || result.frameId !== observation.id ||
          result.coordinateSpace !== "desktop-image-pixels" || result.inputRouting !== "foreground") throw new CuaControlError("protocol_invalid");
      this.frame = { id: observation.id as string, width: integer(observation.width, 1, CUA_LIMITS.imageEdge),
        height: integer(observation.height, 1, CUA_LIMITS.imageEdge), expires: performance.now() + CUA_LIMITS.frameTtlMs };
    } else {
      assertRecord(result, ["status", "effectVerified", "inputRouting", "inputBackend"]);
      if (result.status !== "dispatched" || result.effectVerified !== false || result.inputRouting !== "foreground" ||
          result.inputBackend !== (this.platform === "darwin" ? "macos-cg-event" : "win32-send-input")) throw new CuaControlError("protocol_invalid");
    }
    return result;
  }
}
