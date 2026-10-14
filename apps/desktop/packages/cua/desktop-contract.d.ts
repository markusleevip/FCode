import type { ControlAction } from "./control-contract.js";
export declare const DESKTOP_SCHEMA: 2;
export type DesktopMethod = "desktop_get_state" | "desktop_click" | "desktop_move" | "desktop_scroll" | "desktop_drag" | "desktop_type_text" | "desktop_press_keys";
export interface DesktopAction { schemaVersion: 2; actionId: string; method: DesktopMethod; params: Record<string, unknown> }
export declare function isDesktopMethod(method: unknown): method is DesktopMethod;
export declare function isDesktopInput(method: unknown): boolean;
export declare function validateDesktopAction(value: unknown, platform?: "darwin" | "win32"): DesktopAction;
export declare function validateComputerUseAction(value: unknown, platform?: "darwin" | "win32"): DesktopAction | ControlAction;
