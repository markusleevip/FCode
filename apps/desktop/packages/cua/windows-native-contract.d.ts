import type { ControlTarget } from "./control-contract.js";
export declare const WINDOWS_NATIVE_PROTOCOL: 2;
export declare const WINDOWS_NATIVE_EXECUTABLE: "fcode-cua-helper.exe";
export declare const WINDOWS_RESERVATION_TTL_MS: 1000;
export declare const WINDOWS_CONTROL_BYTES: number;
export declare const WINDOWS_JSON_DEPTH: 64;
export interface WindowsNativeStatus {
  platform: "win32";
  arch: "x64" | "arm64";
  osBuild: number;
  nativeProtocolVersion: 2;
  engineInstanceId: string;
  helperPid: number;
  interactiveDesktop: boolean;
  desktopInterrupted?: boolean;
  hostRole: "prototype-image" | "electron-main";
  capabilities: ("uia-invoke" | "uia-value" | "uia-focus" | "win32-window-messages" | "normal-chrome-page" |
    "uia-observation" | "application-window-ui" | "desktop-lease-journal" | "desktop-monitor-capture" | "win32-send-input")[];
}
export interface WindowsExecutionPayload {
  reservationId: string; actionJson: string; actionDigest: string;
  epoch: number; revision: number; callId: string; target?: ControlTarget; observationId?: string; desktopScope?: string;
}
export interface WindowsNativeResponse {
  schemaVersion: 2; id: string; result?: Record<string, unknown>; error?: { code: string; message: string };
}
export declare function validateWindowsTarget(value: unknown, complete?: boolean): ControlTarget;
export declare function validateWindowsCatalog(value: unknown): {
  apps: { appId: string; pid: number; name: string }[];
  runtime: { platform: "win32"; nativeProtocolVersion: 2; inputRouting: "background"; compatibility: "limited"; methods: string[] };
};
export declare function validateWindowsRequest(value: unknown, channel?: "data" | "control"): {
  schemaVersion: 2; id: string; method: string; params: Record<string, unknown>;
};
export declare function validateWindowsExecutionPayload(text: string): WindowsExecutionPayload;
export declare function validateWindowsStatus(value: unknown): WindowsNativeStatus;
export declare function validateWindowsHello(value: unknown, identity: { nonce: string; helperPid: number; arch: string }): {
  status: WindowsNativeStatus; nonce: string; controlPipe: string;
};
export declare function validateWindowsResponse(value: unknown): WindowsNativeResponse;
export declare function parseWindowsJson(text: string, byteLimit?: number): unknown;
