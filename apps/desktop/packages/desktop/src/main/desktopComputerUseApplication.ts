import { dialog, type BrowserWindow } from "electron";
import { CuaNativeSession } from "@fcode/cua/native-session/node";
import { CuaControlError, type ControlTarget } from "@fcode/cua/control-contract";
import type { DesktopComputerUseChrome } from "./desktopComputerUseChrome.js";
const starting = new WeakSet<CuaNativeSession>();

export function computerUseWindowBackend(native: CuaNativeSession,
  readChrome: () => DesktopComputerUseChrome | undefined, readTarget: () => ControlTarget | undefined) {
  return {
    checkTarget: async () => {
      const target = readTarget(), chrome = readChrome();
      if (!target || chrome?.owns(target)) return;
      // Showing the authorized target is not takeover; the private read still validates its identity.
      await native.applicationWindowUi(target, "read");
    },
    preview: () => {
      const target = readTarget(), chrome = readChrome();
      if (chrome && (!target || chrome.owns(target))) return chrome.preview();
      return target ? native.previewApplicationUi(target) : native.previewWindowUi();
    },
    control: (mode: "show" | "handover" | "background") => {
      const target = readTarget(), chrome = readChrome();
      if (chrome && (!target || chrome.owns(target))) return chrome.control(mode);
      return target ? native.applicationWindowUi(target, mode) : native.controlWindowUi(mode);
    },
  };
}

/** Main-only launch preparation; consent precedes a new application's startup. */
export async function openComputerUseApplication(options: {
  native: CuaNativeSession; appId: string; epoch: number; signal: AbortSignal; window: BrowserWindow;
  assertCurrent(): void; isGranted(target: ControlTarget): boolean; grant(target: ControlTarget): void;
}) {
  if (starting.has(options.native)) throw new CuaControlError("control_busy");
  starting.add(options.native);
  try { return await prepareApplication(options); }
  finally { starting.delete(options.native); }
}

async function prepareApplication(options: Parameters<typeof openComputerUseApplication>[0]) {
  const { native, appId, signal } = options;
  options.assertCurrent();
  if (appId.startsWith("dev.fcode.") || appId === "com.google.Chrome") throw new CuaControlError("not_authorized");
  const installed = await native.installedApplication(appId, signal);
  options.assertCurrent();
  if (installed.appId !== appId) throw new CuaControlError("target_changed");
  if (!installed.target || !options.isGranted(installed.target)) {
    const response = await dialog.showMessageBox(options.window, {
      type: "question", title: "Allow application access", buttons: ["Allow for this task", "Deny"], cancelId: 1, signal,
      message: `Allow Computer Use to open and control ${installed.name.slice(0, 256)}?`,
      detail: "Use the installed application in the background for this task. Ordinary actions will not ask again. Unsupported actions stop instead of taking over your mouse or keyboard. Stop the task to take control.",
    });
    options.assertCurrent();
    if (response.response !== 0) throw new CuaControlError("not_authorized", "Application startup and access were declined for this task.");
  }
  const opened = await native.openApplication(appId, options.epoch, signal);
  options.assertCurrent();
  if (opened.target.appId !== appId) throw new CuaControlError("target_changed");
  options.grant(opened.target);
  return { appId, pid: opened.target.pid };
}
