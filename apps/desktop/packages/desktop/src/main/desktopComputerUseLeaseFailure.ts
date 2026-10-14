import { CuaControlError } from "@fcode/cua/control-contract";
import type { NativeStatus } from "@fcode/cua/native-session/node";
import type { DesktopComputerUsePanel, PanelOwner } from "./desktopComputerUsePanel.js";

/** Read-only diagnosis must not revive a revoked lease or overwrite a human control. */
export async function handleComputerUseLeaseFailure(input: { error: unknown; desktop: boolean;
  panel: DesktopComputerUsePanel; owner: PanelOwner; current(): boolean;
  status(): Promise<NativeStatus>; stop(): Promise<void>;
  diagnostic(value: Record<string, string | boolean | undefined>): void }) {
  if (!input.current()) return;
  const code = input.error instanceof CuaControlError ? input.error.code : "lease_failed";
  let status: NativeStatus | undefined;
  if (input.desktop) {
    try { status = await input.status(); } catch { /* Diagnosis cannot renew or bypass a failed backend. */ }
  }
  if (!input.current() || !input.panel.ownsTask(input.owner) || input.panel.getState(input.owner.ownerId).status !== "active") return;
  input.diagnostic({ code, interrupted: status?.desktopInterrupted, accessibility: status?.accessibility,
    screenRecording: status?.screenRecording, screenLocked: status?.screenLocked });
  if (input.desktop && !status?.desktopInterrupted) {
    const permission = status?.accessibility === false || status?.screenRecording === false;
    input.panel.fail(input.owner, permission ? "permission_required" : "backend_unavailable");
    await input.stop();
  } else {
    await input.panel.request(input.owner.ownerId, { sessionId: input.owner.sessionId, action: "pause" });
  }
}
