import type { ComputerUseCredentialUiState } from "@fcode/shared";
import { CuaControlError } from "@fcode/cua/control-contract";
import type { InvocationScope } from "@fcode/cua/invocation-registry";

type Owner = InvocationScope & { sessionId: string; turnId: string; runtimeScope: string };

/** Projects metadata only. No password or credential reference enters the root renderer. */
export class DesktopComputerUseCredentialUi {
  private request?: Owner & {
    read(): Promise<{ status: "none" | "pending" | "ready"; origin?: string }>;
    focus(origin: string): Promise<unknown>;
  };
  private state: ComputerUseCredentialUiState = { sessionId: null, status: "none" };
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(private ports: {
    isActive(owner: Owner): boolean;
    publish(ownerId: string, state: ComputerUseCredentialUiState): void;
  }) {}

  getState(ownerId: string): ComputerUseCredentialUiState {
    return this.request?.ownerId === ownerId ? { ...this.state } : { sessionId: null, status: "none" };
  }

  begin(request: NonNullable<DesktopComputerUseCredentialUi["request"]>, origin: string) {
    this.clear();
    this.request = request;
    this.state = { sessionId: request.sessionId, status: "pending", origin };
    this.ports.publish(request.ownerId, { ...this.state });
    const generation = this.generation;
    const deadline = performance.now() + 121_000;
    const poll = async () => {
      if (generation !== this.generation) return;
      if (!this.ports.isActive(request) || performance.now() >= deadline) { this.clear(); return; }
      try {
        const result = await request.read();
        if (generation !== this.generation) return;
        if (!this.ports.isActive(request) || result.status === "none" || result.origin !== origin) {
          this.clear(); return;
        }
        if (result.status !== "pending" && result.status !== "ready") { this.clear(); return; }
        if (this.state.status !== result.status) {
          this.state = { sessionId: request.sessionId, status: result.status, origin };
          this.ports.publish(request.ownerId, { ...this.state });
        }
        this.timer = setTimeout(() => { void poll(); }, 1000);
        this.timer.unref();
      } catch { if (generation === this.generation) this.clear(); }
    };
    this.timer = setTimeout(() => { void poll(); }, 1000);
    this.timer.unref();
  }

  async focus(ownerId: string, sessionId: string): Promise<void> {
    const request = this.request;
    if (!request || request.ownerId !== ownerId || request.sessionId !== sessionId ||
        this.state.status !== "pending" || !this.state.origin || !this.ports.isActive(request)) {
      throw new CuaControlError("not_authorized", "The private credential request is no longer active.");
    }
    await request.focus(this.state.origin);
  }

  closeTurn(sessionId: string, turnId: string) {
    if (this.request?.sessionId === sessionId && this.request.turnId === turnId) this.clear();
  }

  clear() {
    const ownerId = this.request?.ownerId;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request = undefined;
    this.state = { sessionId: null, status: "none" };
    if (ownerId) this.ports.publish(ownerId, { ...this.state });
  }
}
