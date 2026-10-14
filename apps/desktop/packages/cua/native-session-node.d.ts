import type { DesktopAction } from "./desktop-contract.js";
import type { ControlAction, ControlTarget } from "./control-contract.js";
export interface NativeStatus {
  available: boolean; platform: "darwin"; protocolVersion: 3 | 4;
  desktopObservation?: boolean; desktopInput?: boolean; physicalEscapeTakeover?: boolean; desktopInterrupted?: boolean;
  secureEventInput?: boolean; postEventAccess?: boolean; minimumMacOS: string;
  axBatchObservation: boolean;
  nativeWindowInput?: boolean;
  nativeWindowSelectionAssist?: boolean;
  nativeWindowInputCompatibility?: "experimental-appkit-window-events";
  inputMethods?: { backgroundExternal: string[]; backgroundOwned: string[]; foregroundTestOnly: string[] };
  grantOwner: string; pid: number; managedBrowser: boolean; credentialInput: boolean; controlUi: boolean; normalBrowserUi: boolean; applicationLaunch: boolean; applicationWindowUi: boolean; screenLocked: boolean; accessibility: boolean; screenRecording: boolean; capabilities: string[]; inputRoutings: ("background" | "foreground")[];
}
export declare class CuaNativeSession {
  constructor(options: { executablePath: string; diagnostic?: boolean; inputRouting?: "background" | "foreground" });
  readonly state: { running: boolean; uncertain: boolean };
  status(signal?: AbortSignal): Promise<NativeStatus>;
  installedApplication(appId: string, signal?: AbortSignal): Promise<{ appId: string; name: string; target?: ControlTarget }>;
  openApplication(appId: string, epoch: number, signal?: AbortSignal): Promise<{ target: ControlTarget; created: boolean }>;
  previewApplicationUi(target: ControlTarget, signal?: AbortSignal): Promise<{ image: { mimeType: "image/png"; data: string }; previewFrameGeometry?: unknown }>;
  applicationWindowUi(target: ControlTarget, mode: "read" | "show" | "handover" | "background"): Promise<Record<string, unknown>>;
  previewWindowUi(signal?: AbortSignal): Promise<{ image: { mimeType: "image/png"; data: string } }>;
  previewChromeUi(target: ControlTarget, signal?: AbortSignal): Promise<{ image: { mimeType: "image/png"; data: string }; previewFrameGeometry?: unknown }>;
  chromeCredentialUi(params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  chromeWindowUi(target: ControlTarget, mode: "read" | "show" | "handover" | "background"): Promise<Record<string, unknown>>;
  controlWindowUi(mode: "show" | "handover" | "background"): Promise<{ status: string }>;
  credentialUiStatus(signal?: AbortSignal): Promise<{ status: "none" | "pending" | "ready"; origin?: string }>;
  focusCredentialUi(origin: string, epoch: number, signal?: AbortSignal): Promise<{ status: "focused" }>;
  requestPermissions(value: { accessibility: boolean; screenRecording: boolean }, signal?: AbortSignal): Promise<NativeStatus>;
  resolveTarget(target: ControlTarget | Record<string, unknown>, signal?: AbortSignal): Promise<ControlTarget>;
  lease(epoch: number, ttlMs?: number): Promise<void>;
  desktopDisplays(signal?: AbortSignal): Promise<Record<string, unknown>>;
  desktopScope(scopeId: string, displayId: string, epoch: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  execute(request: { action: ControlAction | DesktopAction; desktopScope?: string; target?: ControlTarget; epoch: number; revision: number;
    callId: string; approved?: boolean }, signal?: AbortSignal, assertCurrent?: () => void): Promise<Record<string, unknown>>;
  stop(epoch?: number): Promise<void>;
  close(): Promise<void>;
}
