export { DESKTOP_SCHEMA as WINDOWS_DESKTOP_SCHEMA, isDesktopMethod as isWindowsDesktopMethod, isDesktopInput as isWindowsDesktopInput, validateComputerUseAction } from "./desktop-contract.js";
import { validateDesktopAction } from "./desktop-contract.js";

/** Keep the Windows public validator strict even when transport supports both platforms. */
export function validateWindowsDesktopAction(value) { return validateDesktopAction(value, "win32"); }
