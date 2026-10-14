import { CuaControlError } from "@fcode/cua/control-contract";

type Window = { isDestroyed(): boolean; isVisible(): boolean; isModal(): boolean; minimize(): void };

/** Trusted Main UI handoff; never hide or approve a protected modal. */
export async function handoffMacDesktop(ports: { windows(): Window[]; isHidden(): boolean; hide(): void; settle(): Promise<void> }) {
  const windows = ports.windows().filter((window) => !window.isDestroyed() && window.isVisible());
  if (windows.some((window) => window.isModal())) {
    throw new CuaControlError("control_busy", "Complete the private FCode dialog before continuing desktop control.",
      { stage: "native", requiresUserAction: true });
  }
  if (ports.isHidden()) return;
  for (const window of windows) window.minimize();
  // Minimization alone can leave this application as macOS's active keyboard receiver.
  ports.hide();
  await ports.settle();
}
