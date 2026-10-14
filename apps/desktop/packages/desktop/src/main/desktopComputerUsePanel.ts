import { CuaControlError, isInputMethod } from "@fcode/cua/control-contract";
import { DesktopComputerUsePointer, type ComputerUsePointerDiagnostic } from "./desktopComputerUsePointer.js";
import type { InvocationScope } from "@fcode/cua/invocation-registry";
import { computerUsePanelStateSchema, type ComputerUsePanelState, type ComputerUsePanelRequest } from "@fcode/shared";

export type PanelOwner = InvocationScope & { sessionId: string; turnId: string; runtimeScope: string };
type Backend = {
  preview(): Promise<{ image: { mimeType: string; data: string }; previewFrameGeometry?: unknown }>;
  control(mode: "show" | "handover"): Promise<unknown>;
  stop(): Promise<void>;
  close(): Promise<void>;
};
const EMPTY: ComputerUsePanelState = { sessionId: null, status: "none" };

/** One scope-bound image in memory; renderer visibility drives bounded sampling. */
export class DesktopComputerUsePanel {
  private owner?: PanelOwner;
  private backend?: Backend;
  private state: ComputerUsePanelState = EMPTY;
  private generation = 0;
  private sampling = false;
  private lastSample = -Infinity;
  private expiry?: ReturnType<typeof setTimeout>;
  private previewError?: string;
  private transition?: number;
  private pointer: DesktopComputerUsePointer;

  constructor(private ports: {
    publish(ownerId: string, state: ComputerUsePanelState): void;
    isActive(owner: PanelOwner): boolean;
    pointerDiagnostic?: (code: ComputerUsePointerDiagnostic) => void;
  }) { this.pointer = new DesktopComputerUsePointer(Date.now, ports.pointerDiagnostic); }

  getState(ownerId: string) { return this.owner?.ownerId === ownerId ? { ...this.state } : { ...EMPTY }; }

  isRetained() { return this.state.status === "paused" || this.state.status === "handover"; }

  matches(owner: Pick<PanelOwner, "ownerId" | "sessionId">) {
    return this.owner?.ownerId === owner.ownerId && this.owner.sessionId === owner.sessionId;
  }

  belongsToHost(hostId: string) { return this.owner?.hostId === hostId; }

  ownsTask(owner: PanelOwner) {
    return this.owner?.ownerId === owner.ownerId && this.owner.hostId === owner.hostId &&
      this.owner.workspaceKey === owner.workspaceKey && this.owner.sessionId === owner.sessionId && this.owner.turnId === owner.turnId;
  }

  assertAllowed(owner: PanelOwner) {
    if (this.transition !== undefined) throw new CuaControlError("control_busy", "Computer Use control is changing.");
    if (this.state.status !== "active" && this.state.status !== "none" && this.owner?.turnId === owner.turnId && this.matches(owner)) {
      throw new CuaControlError("canceled", "Computer Use is paused. Resume with an explicit new task.");
    }
  }

  begin(owner: PanelOwner, backend: Backend) {
    this.assertAllowed(owner);
    if (this.matches(owner) && this.owner?.turnId === owner.turnId) {
      this.backend = backend;
      this.state.stage = "preparing";
      this.publish(); return;
    }
    const previous = this.matches(owner) && this.isRetained() ? this.state : EMPTY;
    this.clear();
    this.owner = owner;
    this.backend = backend;
    this.state = { ...previous, sessionId: owner.sessionId, status: "active", executing: false, previewFailed: false };
    this.publish();
  }

  waiting(owner: PanelOwner, backend: Backend) {
    if (this.isRetained()) return;
    this.begin(owner, backend);
    this.state.stage = "waiting_model";
    this.publish();
  }

  stage(owner: PanelOwner, value: NonNullable<ComputerUsePanelState["stage"]>) {
    if (!this.ownsTask(owner) || this.state.status !== "active") return;
    this.state.stage = value; this.publish();
  }

  fail(owner: PanelOwner, reason: NonNullable<ComputerUsePanelState["failureReason"]>) {
    if (!this.ownsTask(owner) || (this.state.status !== "active" && this.state.stage !== "ended")) return;
    this.state.status = "ended";
    this.state.stage = "needs_resume";
    this.state.failureReason = reason;
    this.state.executing = false;
    this.pointer.clear(); this.publish(); this.expire(false);
  }

  action(owner: PanelOwner, method: string, executing: boolean, result?: Record<string, unknown>) {
    if (!this.matches(owner) || this.owner?.turnId !== owner.turnId || this.state.status !== "active") return;
    if (executing && isInputMethod(method)) this.pointer.clear();
    const observation = result?.observation as Record<string, unknown> | undefined;
    const target = (result?.target ?? observation?.target) as Record<string, unknown> | undefined;
    if (target && typeof target.appId === "string") this.state.target = target.appId.slice(0, 512);
    if (result?.inputBackend === "native-owned-webkit" || result?.browser || observation?.target) this.state.managed = true;
    const application = result?.application as Record<string, unknown> | undefined;
    if (result?.inputRouting === "foreground" || result?.inputRouting === "background") this.state.inputRouting = result.inputRouting;
    if (typeof application?.name === "string") this.state.applicationName = application.name.slice(0, 512);
    if (result?.browser) delete this.state.applicationName;
    const browser = result?.browser as Record<string, unknown> | undefined;
    if (typeof browser?.origin === "string") this.state.target = browser.origin.slice(0, 512);
    const image = result?.image as Record<string, unknown> | undefined;
    if (browser?.browserName !== "Google Chrome" && image?.mimeType === "image/png" && typeof image.data === "string" && image.data.length <= 6 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      this.state.image = `data:image/png;base64,${image.data}`;
      this.state.updatedAt = Date.now();
      this.state.previewFailed = false;
      this.pointer.frame(result?.previewFrameGeometry);
    }
    if (result?.status === "dispatched") this.pointer.input(result.operationPointerReceipt);
    // Method names only: never project action arguments or typed content.
    this.state.action = method.slice(0, 64);
    this.state.executing = executing;
    this.state.stage = executing ? "operating" : "waiting_model";
    this.publish();
  }

  clearPointer(owner: PanelOwner) {
    if (!this.matches(owner) || this.owner?.turnId !== owner.turnId) return;
    this.pointer.clear();
    this.publish();
  }

  async request(ownerId: string, request: ComputerUsePanelRequest) {
    const owner = this.owner;
    const backend = this.backend;
    if (!owner || !backend || owner.ownerId !== ownerId || owner.sessionId !== request.sessionId) {
      throw new CuaControlError("not_authorized");
    }
    if (request.action === "preview") {
      if (this.transition !== undefined || this.state.status !== "active" || !this.state.managed || !this.ports.isActive(owner) ||
          this.sampling || performance.now() - this.lastSample < 1900) return this.getState(ownerId);
      this.sampling = true;
      this.lastSample = performance.now();
      const generation = this.generation;
      try {
        const frame = await backend.preview();
        if (generation !== this.generation || this.state.status !== "active" || !this.ports.isActive(owner)) return this.getState(ownerId);
        if (frame.image.mimeType !== "image/png" || frame.image.data.length > 6 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.image.data)) throw new CuaControlError("protocol_invalid");
        this.state.image = `data:image/png;base64,${frame.image.data}`;
        this.state.updatedAt = Date.now();
        this.state.previewFailed = false;
        this.previewError = undefined;
        this.pointer.frame(frame.previewFrameGeometry);
      } catch (error) {
        if (generation === this.generation) {
          this.state.previewFailed = true;
          this.pointer.reset();
          const code = error instanceof CuaControlError ? error.code : "preview_unavailable";
          if (code !== this.previewError) console.warn(`[computer-use-panel] Preview unavailable: ${code}`);
          this.previewError = code;
        }
      } finally { if (generation === this.generation) this.sampling = false; }
      this.publish();
    } else {
      if (this.transition !== undefined) throw new CuaControlError("control_busy");
      if (request.action === "stop") {
        const generation = ++this.generation;
        this.transition = generation;
        this.state.status = "ended";
        this.state.executing = false;
        this.pointer.clear();
        this.publish();
        try {
          try { await backend.stop(); }
          finally {
            if (generation === this.generation) {
              await backend.close();
              if (generation === this.generation) this.expire(false);
            }
          }
        } finally { if (this.transition === generation) this.transition = undefined; }
        return this.getState(ownerId);
      }
      if ((request.action !== "pause" && !this.state.managed) || this.state.status === "ended") throw new CuaControlError("not_authorized");
      if (request.action === "show") await backend.control("show");
      else {
        const generation = ++this.generation;
        this.transition = generation;
        this.sampling = false;
        this.state.status = "paused";
        this.state.executing = false;
        this.pointer.clear();
        this.publish();
        try {
          await backend.stop();
          if (generation !== this.generation) return this.getState(ownerId);
          if (request.action === "handover") {
            await backend.control("handover");
            if (generation !== this.generation) return this.getState(ownerId);
            this.state.status = "handover";
            this.publish();
          }
        } finally {
          if (generation === this.generation) this.expire(true);
          if (this.transition === generation) this.transition = undefined;
        }
      }
    }
    return this.getState(ownerId);
  }

  closeTurn(sessionId: string, turnId: string) {
    if (this.owner?.sessionId !== sessionId || this.owner.turnId !== turnId || this.isRetained() || this.transition !== undefined) return;
    this.generation++;
    this.state.status = "ended";
    if (this.state.stage !== "needs_resume") this.state.stage = "ended";
    this.state.executing = false;
    this.pointer.clear();
    this.publish();
    this.expire(false);
  }

  clear() {
    const ownerId = this.owner?.ownerId;
    this.generation++;
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.sampling = false;
    this.lastSample = -Infinity;
    this.previewError = undefined;
    this.transition = undefined;
    this.pointer.reset();
    this.state = { ...EMPTY };
    this.owner = undefined;
    this.backend = undefined;
    if (ownerId) this.ports.publish(ownerId, { ...EMPTY });
  }

  private expire(close: boolean) {
    clearTimeout(this.expiry);
    const backend = this.backend;
    this.expiry = setTimeout(() => {
      this.clear();
      if (close) void backend?.close();
    }, 10 * 60_000);
    this.expiry.unref();
  }

  private publish() {
    delete this.state.previewGeometry;
    delete this.state.operationPointer;
    const display = this.pointer.state();
    if (display.previewGeometry) this.state.previewGeometry = display.previewGeometry;
    if (this.state.status === "active" && !this.state.previewFailed && display.operationPointer) this.state.operationPointer = display.operationPointer;
    if (this.owner) this.ports.publish(this.owner.ownerId, computerUsePanelStateSchema.parse(this.state));
  }
}
