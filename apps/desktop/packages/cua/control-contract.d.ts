export declare const CUA_PROTOCOL_VERSION: 1;
export declare const CUA_OFFICIAL_PLUGIN_ID: "computer-use@fcode-plugins-official";
export declare const CUA_LIMITS: Readonly<Record<"requestBytes" | "responseBytes" | "textBytes" |
  "imageEdge" | "elementCount" | "frameTtlMs" | "callTtlMs" | "leaseTtlMs" | "heartbeatMs" |
  "actionTimeoutMs" | "queueSize" | "resultCount" | "approvalCount" | "approvalTtlMs", number>>;
export type ControlMethod = "list_apps" | "open_browser" | "open_application" | "list_windows" | "capture" | "get_app_state" |
  "activate_window" | "click" | "move" | "drag" | "scroll" | "type_text" | "request_credential" | "type_credential" | "press_keys" | "element_action" | "prepare_input";
export interface ControlAction {
  schemaVersion: 1;
  actionId: string;
  method: ControlMethod;
  params: Record<string, unknown>;
}
export interface ControlRegion { x: number; y: number; width: number; height: number }
export interface ControlTarget {
  appId: string; pid: number; instanceId: string; windowId?: number;
  region?: ControlRegion; topologyVersion?: string;
}
export interface ControlObservation {
  id: string; target: ControlTarget; width: number; height: number;
  region: ControlRegion; topologyVersion: string;
  elements?: ReadonlyArray<Record<string, unknown>>;
  elementsTruncated?: boolean;
  elementsTruncationReason?: string | null;
  targetAppIsForeground?: boolean | null; targetWindowIsForeground?: boolean | null;
}
export interface ControlErrorDetails { stage?: string; reason?: string; retryable?: boolean; requiresUserAction?: boolean }
export declare function controlErrorDetails(value: unknown): ControlErrorDetails;
export declare class CuaControlError extends Error implements ControlErrorDetails {
  code: string; stage?: string; reason?: string; retryable?: boolean; requiresUserAction?: boolean;
  constructor(code: string, message?: string, details?: ControlErrorDetails);
}
export declare function assertRecord(value: unknown, fields: string[], required?: string[]): Record<string, unknown>;
export declare function assertString(value: unknown, maxLength?: number): string;
export declare function isControlMethod(method: unknown): method is ControlMethod;
export declare function isInputMethod(method: unknown): boolean;
export declare function validateControlAction(value: unknown): ControlAction;
export declare function canonicalAction(value: unknown): string;
