import type { ControlTarget } from "./control-contract.js";
import type { ControlRequest, ControlResult } from "./control-authority.js";
import type { WindowsNativeStatus } from "./windows-native-contract.js";
import type { WindowsDesktopAction } from "./windows-desktop-contract.js";
export interface WindowsDesktopExecution { action: WindowsDesktopAction; epoch: number; revision: number; callId: string; desktopScope: string }
export interface WindowsNativeSessionOptions {
  executablePath: string;
  signal?: AbortSignal;
  verifyHelper(executablePath: string): Promise<{ parentImageSha256: string }>;
}
export declare class CuaWindowsNativeSession {
  private constructor(options: WindowsNativeSessionOptions);
  static start(options: WindowsNativeSessionOptions): Promise<CuaWindowsNativeSession>;
  readonly state: { running: boolean; uncertain: boolean };
  status(signal?: AbortSignal): Promise<WindowsNativeStatus>;
  resolveTarget(target: Record<string, unknown> | ControlTarget, signal?: AbortSignal): Promise<ControlTarget>;
  installedApplication(appId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  openApplication(appId: string, epoch: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  previewApplicationUi(target: ControlTarget, signal?: AbortSignal): Promise<Record<string, unknown>>;
  applicationWindowUi(target: ControlTarget, mode: "read" | "show" | "handover" | "background"): Promise<Record<string, unknown>>;
  desktopDisplays(signal?: AbortSignal): Promise<Record<string, unknown>>;
  desktopScope(scopeId: string, displayId: string, epoch: number, signal?: AbortSignal): Promise<void>;
  lease(epoch: number, ttlMs?: number): Promise<void>;
  execute(request: ControlRequest | WindowsDesktopExecution, signal?: AbortSignal, assertCurrent?: () => void): Promise<ControlResult>;
  stop(epoch?: number): Promise<void>;
  close(): Promise<void>;
}
