import type { ControlAction } from "./control-contract.js";
import type { WindowsDesktopAction } from "./windows-desktop-contract.js";
export interface ControlTransportContext {
  sessionId: string; turnId: string; toolCallId: string; workspaceKey: string; runtimeScope: "main";
}
export declare function createControlTransport(options: {
  socketPath: string; token: string;
  execute(context: ControlTransportContext, action: ControlAction | WindowsDesktopAction, signal: AbortSignal): Promise<Record<string, unknown>>;
}): { start(): Promise<void>; stop(): Promise<void> };
