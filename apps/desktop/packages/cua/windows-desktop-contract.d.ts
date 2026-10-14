export { DESKTOP_SCHEMA as WINDOWS_DESKTOP_SCHEMA, isDesktopMethod as isWindowsDesktopMethod, isDesktopInput as isWindowsDesktopInput, validateComputerUseAction } from "./desktop-contract.js";
export type { DesktopAction as WindowsDesktopAction, DesktopMethod as WindowsDesktopMethod } from "./desktop-contract.js";
import type { DesktopAction } from "./desktop-contract.js";
export declare function validateWindowsDesktopAction(value: unknown): DesktopAction;
