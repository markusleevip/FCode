import { DesktopRoute } from "./desktopDesktopRoute.js";
import type { DesktopAction } from "@fcode/cua/desktop-contract";
import type { CuaNativeSession } from "@fcode/cua/native-session/node";
import { CuaControlError } from "@fcode/cua/control-contract";
import type { DesktopComputerUsePanel, PanelOwner } from "./desktopComputerUsePanel.js";

export class MacDesktopRoute extends DesktopRoute {
  constructor(ports: ConstructorParameters<typeof DesktopRoute>[0]) { super(ports, "darwin"); }
}

export async function executeMacDesktopAction(input: { desktop: MacDesktopRoute; panel: DesktopComputerUsePanel;
  session: CuaNativeSession; owner: PanelOwner; action: DesktopAction; callId: string; epoch: number;
  signal: AbortSignal; assertCurrent(): void; stop(): Promise<void> }) {
  const { desktop, panel, session, owner, action, signal } = input;
  const status = await session.status(signal);
  if (status.protocolVersion !== 4 || !status.desktopObservation || !status.desktopInput || !status.physicalEscapeTakeover) {
    throw new CuaControlError("unsupported_action", "The installed Helper does not support macOS desktop control. Rebuild the Helper and restart FCode.",
      { stage: "native", reason: "protocol_mismatch", requiresUserAction: true });
  }
  panel.action(owner, action.method, true, { inputRouting: "foreground" });
  try {
    const result = await desktop.execute({ owner, callId: input.callId, action, native: session, epoch: input.epoch, signal,
      assertCurrent: input.assertCurrent });
    panel.action(owner, action.method, false, result); return result;
  } catch (error) {
    desktop.invalidateFrame();
    // Foreground contention is recoverable; it does not express human cancellation.
    if (!(error instanceof CuaControlError) || !["observation_stale", "target_changed", "unsupported_action", "invalid_request", "control_busy"].includes(error.code)) await input.stop();
    panel.clearPointer(owner); throw error;
  } finally { panel.action(owner, action.method, false); }
}
