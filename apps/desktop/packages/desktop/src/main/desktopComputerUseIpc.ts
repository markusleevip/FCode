import { BrowserWindow, ipcMain } from "electron";
import { PlatformChannels, computerUseIntentRequestSchema, computerUseCredentialUiRequestSchema,
  computerUsePanelRequestSchema, type ComputerUsePanelRequest, type ComputerUsePanelState,
  type ComputerUseIntentRequest, type ComputerUseCredentialUiState } from "@fcode/shared";

export function registerDesktopComputerUseIpc(options: {
  ownsWindow(win: BrowserWindow): boolean;
  prepareIntent(ownerId: string, input: ComputerUseIntentRequest): Promise<{ token: string }>;
  getCredentialUi(ownerId: string): ComputerUseCredentialUiState;
  focusCredentialUi(ownerId: string, sessionId: string): Promise<void>;
  getPanel(ownerId: string): ComputerUsePanelState;
  panelAction(ownerId: string, request: ComputerUsePanelRequest): Promise<ComputerUsePanelState>;
}) {
  ipcMain.handle(PlatformChannels.PrepareComputerUseIntent, async (event, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !options.ownsWindow(win) || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Computer Use selection requires the root FCode desktop window.");
    }
    return options.prepareIntent(String(win.id), computerUseIntentRequestSchema.parse(value));
  });
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !options.ownsWindow(win) || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Private credential UI requires the root FCode desktop window.");
    }
    return String(win.id);
  };
  ipcMain.handle(PlatformChannels.GetComputerUseCredentialUi, (event) => options.getCredentialUi(owner(event)));
  ipcMain.handle(PlatformChannels.GetComputerUsePanel, (event) => options.getPanel(owner(event)));
  ipcMain.handle(PlatformChannels.ComputerUsePanelAction, (event, value: unknown) =>
    options.panelAction(owner(event), computerUsePanelRequestSchema.parse(value)));
  ipcMain.handle(PlatformChannels.FocusComputerUseCredentialUi, (event, value: unknown) =>
    options.focusCredentialUi(owner(event), computerUseCredentialUiRequestSchema.parse(value).sessionId));
}
