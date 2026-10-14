import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, dialog, type BrowserWindow } from "electron";
import { PlatformChannels } from "@fcode/shared";
import { CuaControlError } from "@fcode/cua/control-contract";
import { CuaWindowsNativeSession } from "@fcode/cua/windows-native-session/node";
import { createWindowsComputerUseController } from "./desktopWindowsComputerUseControl.js";
import { resolveWindowsComputerUseHelperResource } from "./desktopWindowsComputerUseResources.js";
import { verifyWindowsComputerUseHelper } from "./desktopWindowsComputerUseTrust.js";
import { windowsControlFailureDiagnostic } from "./desktopWindowsComputerUseFailureDiagnostic.js";

/** Electron adapter for the independent Windows controller; no resources start here. */
export function createDesktopWindowsComputerUseControl(options: {
  helperResourceRoot: string; getWindow(ownerId: string): BrowserWindow | undefined;
}) {
  const resource = () => resolveWindowsComputerUseHelperResource({ root: options.helperResourceRoot,
    packaged: app.isPackaged, platform: process.platform, arch: process.arch });
  const window = (id: string) => {
    const win = options.getWindow(id);
    if (!win || win.isDestroyed()) throw new CuaControlError("canceled");
    return win;
  };
  const settings = () => join(app.getPath("userData"), "computer-use-settings.json");
  return createWindowsComputerUseController({
    diagnoseFailure: (stage, error) => console.warn("[windows-cua] control-failure", windowsControlFailureDiagnostic(stage, error)),
    hostPid: process.pid,
    available: () => Boolean(resource()),
    window: (id) => {
      const win = options.getWindow(id);
      return !win || win.isDestroyed() ? undefined : { visible: win.isVisible(), minimized: win.isMinimized() };
    },
    readEnabled: async () => {
      try {
        const value = JSON.parse(await readFile(settings(), "utf8"));
        return value.enabled === true && [1, 2].includes(value.privacyVersion);
      } catch { return false; }
    },
    writeEnabled: (enabled) => writeFile(settings(), JSON.stringify({ enabled, privacyVersion: 1 }), { mode: 0o600 }),
    approve: async (id, request, signal) => {
      const enable = request.kind === "enable";
      const desktop = request.kind === "desktop";
      const response = await dialog.showMessageBox(window(id), {
        type: "question", title: desktop ? "Allow desktop control" : enable ? "Enable Computer Use" : "Allow application access",
        buttons: enable ? ["Enable and continue", "Cancel"] : ["Allow for this task", "Deny"], cancelId: 1, signal,
        message: desktop ? "Allow Computer Use to operate your primary Windows display for this task?" : enable ? "Computer Use can observe and operate your selected applications." :
          `Allow Computer Use to observe and control ${request.target?.appId}?`,
        detail: desktop ? "Visible desktop screenshots will be sent to your selected model. Computer Use can open Start, discover applications and use the real mouse, keyboard and foreground across applications. FCode will minimize during control. Press the physical Esc key or use the panel Pause/Stop controls to pause or stop automation. Other mouse and keyboard activity does not signal takeover. This permission expires with this task." : enable ? "Selected window screenshots and interface content are sent to your model. Select Computer Use for each task. You can stop or disable it at any time." :
          "Allow supported background actions in this application instance for this task. Unsupported actions are rejected. Stop or take control to end automation.",
      });
      if (desktop && response.response === 0) await writeFile(settings(), JSON.stringify({ enabled: true, privacyVersion: 2 }), { mode: 0o600 });
      return response.response === 0;
    },
    prepareDesktop: async (id) => {
      const win = window(id); win.minimize();
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    startNative: async (signal) => {
      signal.throwIfAborted();
      const executablePath = resource();
      if (!executablePath) throw new CuaControlError("backend_unavailable");
      const session = await CuaWindowsNativeSession.start({ executablePath, signal,
        verifyHelper: (path) => verifyWindowsComputerUseHelper({ executablePath: path, hostExecutable: process.execPath,
          hostEntry: app.isPackaged ? join(process.resourcesPath, "app.asar") : join(app.getAppPath(), "out/main/index.js"),
          isMain: process.type === "browser", packaged: app.isPackaged }),
      });
      if (signal.aborted) { await session.close(); signal.throwIfAborted(); }
      return session;
    },
    publish: (id, state) => {
      const win = options.getWindow(id);
      if (win && !win.isDestroyed()) win.webContents.send(PlatformChannels.ComputerUsePanelChanged, state);
    },
  });
}
