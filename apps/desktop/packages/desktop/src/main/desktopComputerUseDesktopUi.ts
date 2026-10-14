import { app, BrowserWindow, dialog } from "electron";
import { MacDesktopRoute } from "./desktopMacDesktopRoute.js";
import { handoffMacDesktop } from "./desktopMacDesktopHandoff.js";

export function createMacDesktopUi(requireWindow: (ownerId: string) => BrowserWindow) {
  const prepare: ConstructorParameters<typeof MacDesktopRoute>[0]["prepare"] = async (owner) => {
    requireWindow(owner.ownerId);
    await handoffMacDesktop({ windows: () => BrowserWindow.getAllWindows(), isHidden: () => app.isHidden(),
      hide: () => app.hide(), settle: () => new Promise((resolve) => setTimeout(resolve, 200)) });
  };
  return new MacDesktopRoute({
    approve: async (owner, displayId, signal) => {
      const response = await dialog.showMessageBox(requireWindow(owner.ownerId), {
        type: "question", title: "Allow desktop control", buttons: ["Allow for this task", "Cancel"], cancelId: 1, signal,
        message: "Computer Use will operate your real desktop, mouse and keyboard.",
        detail: `Display ${displayId} screenshots may include other applications and will be sent to the selected model. FCode will hide while operating. Ordinary mouse, keyboard and app switching do not cancel this task. Press physical Esc to pause, or use Pause/Stop in FCode. This permission is separate from selected-window access.`,
      });
      return response.response === 0;
    },
    prepare,
    beforeObserve: prepare,
  });
}
