import { CUA_LIMITS, CuaControlError, assertRecord, assertString, validateControlAction } from "./control-contract.js";

export const DESKTOP_SCHEMA = 2;
const RULES = Object.freeze({
  desktop_get_state: { fields: ["displayId"], required: [] },
  desktop_click: { fields: ["frameId", "x", "y", "button", "count"], required: ["frameId", "x", "y"] },
  desktop_move: { fields: ["frameId", "x", "y"], required: ["frameId", "x", "y"] },
  desktop_scroll: { fields: ["frameId", "x", "y", "deltaX", "deltaY"], required: ["frameId", "x", "y", "deltaY"] },
  desktop_drag: { fields: ["frameId", "x", "y", "toX", "toY", "durationMs"], required: ["frameId", "x", "y", "toX", "toY"] },
  desktop_type_text: { fields: ["frameId", "text"], required: ["frameId", "text"] },
  desktop_press_keys: { fields: ["frameId", "keys"], required: ["frameId", "keys"] },
});
const COMMON_KEYS = new Set(["CTRL", "SHIFT", "ENTER", "ESC", "TAB", "SPACE", "BACKSPACE", "DELETE",
  "INSERT", "HOME", "END", "PAGEUP", "PAGEDOWN", "UP", "DOWN", "LEFT", "RIGHT"]);
export function isDesktopMethod(method) { return typeof method === "string" && Object.hasOwn(RULES, method); }
export function isDesktopInput(method) { return isDesktopMethod(method) && method !== "desktop_get_state"; }
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new CuaControlError("invalid_request");
}
export function validateDesktopAction(value, platform) {
  if (platform !== undefined && !["darwin", "win32"].includes(platform)) throw new CuaControlError("platform_unsupported");
  const platformKeys = platform === "darwin" ? ["CMD", "OPTION", "ALT"] : platform === "win32" ? ["WIN", "ALT"] : ["WIN", "ALT", "CMD", "OPTION"];
  const action = assertRecord(value, ["schemaVersion", "actionId", "method", "params"]);
  if (action.schemaVersion !== DESKTOP_SCHEMA || !isDesktopMethod(action.method)) throw new CuaControlError("invalid_request");
  assertString(action.actionId, 128);
  const rule = RULES[action.method], params = assertRecord(action.params, rule.fields, rule.required);
  for (const key of ["frameId", "displayId"]) if (key in params) assertString(params[key], 128);
  for (const key of ["x", "y", "toX", "toY"]) if (key in params) integer(params[key], 0, 100_000);
  for (const key of ["deltaX", "deltaY"]) if (key in params) integer(params[key], -10_000, 10_000);
  if ("durationMs" in params) integer(params.durationMs, 100, 2000);
  if ("count" in params) integer(params.count, 1, 3);
  if ("button" in params && !["left", "right", "middle"].includes(params.button)) throw new CuaControlError("invalid_request");
  if ("text" in params) assertString(params.text, CUA_LIMITS.textBytes);
  if ("keys" in params) {
    if (!Array.isArray(params.keys) || params.keys.length < 1 || params.keys.length > 8 || new Set(params.keys).size !== params.keys.length) {
      throw new CuaControlError("invalid_request");
    }
    if (platform === "darwin") {
      if (params.keys.filter((key) => !["CMD", "OPTION", "ALT", "CTRL", "SHIFT"].includes(key)).length !== 1) throw new CuaControlError("invalid_request");
      if (params.keys.includes("INSERT") || params.keys.some((key) => /^F(?:2[1-4])$/.test(key))) throw new CuaControlError("unsupported_action");
    }
    for (const key of params.keys) {
      if (typeof key !== "string" || (!COMMON_KEYS.has(key) && !platformKeys.includes(key) && !/^[A-Z0-9]$/.test(key) && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))) {
        throw new CuaControlError("unsupported_action", "Unsupported desktop key name.");
      }
    }
  }
  return structuredClone(action);
}

/** Additive transport dispatch; the legacy application validator stays unchanged. */
export function validateComputerUseAction(value, platform) {
  return value?.schemaVersion === DESKTOP_SCHEMA ? validateDesktopAction(value, platform) : validateControlAction(value);
}
