import { CUA_LIMITS, CuaControlError, assertRecord, assertString, canonicalAction, validateControlAction } from "./control-contract.js";
import { validateWindowsDesktopAction } from "./windows-desktop-contract.js";

export const WINDOWS_NATIVE_PROTOCOL = 2;
export const WINDOWS_NATIVE_EXECUTABLE = "fcode-cua-helper.exe";
export const WINDOWS_RESERVATION_TTL_MS = 1000;
export const WINDOWS_CONTROL_BYTES = 16 * 1024;
export const WINDOWS_JSON_DEPTH = 64;
const HEX_256 = /^[0-9a-f]{64}$/;
const INPUT_ROUTES = new Set(["uia-invoke", "uia-value", "uia-focus", "win32-window-messages", "normal-chrome-page",
  "uia-observation", "application-window-ui", "desktop-lease-journal", "desktop-monitor-capture", "win32-send-input"]);
const WINDOWS_CATALOG_METHODS = new Set(["list_apps", "list_windows", "capture", "get_app_state", "element_action", "click", "type_text", "press_keys"]);
const MAX_CATALOG_APPS = 4096;

function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new CuaControlError("invalid_request");
  return value;
}

function hex(value) {
  if (typeof value !== "string" || !HEX_256.test(value)) throw new CuaControlError("invalid_request");
  return value;
}

export function validateWindowsCatalog(value) {
  const catalog = assertRecord(value, ["apps", "runtime"]);
  if (!Array.isArray(catalog.apps) || catalog.apps.length > MAX_CATALOG_APPS) throw new CuaControlError("protocol_invalid");
  for (const entry of catalog.apps) {
    const app = assertRecord(entry, ["appId", "pid", "name"]);
    assertString(app.appId, 2048); integer(app.pid); assertString(app.name, 1024);
  }
  const runtime = assertRecord(catalog.runtime, ["platform", "nativeProtocolVersion", "inputRouting", "compatibility", "methods", "desktop"],
    ["platform", "nativeProtocolVersion", "inputRouting", "compatibility", "methods"]);
  if (runtime.platform !== "win32" || runtime.nativeProtocolVersion !== WINDOWS_NATIVE_PROTOCOL || runtime.inputRouting !== "background" ||
      runtime.compatibility !== "limited" || !Array.isArray(runtime.methods) || runtime.methods.length > WINDOWS_CATALOG_METHODS.size ||
      new Set(runtime.methods).size !== runtime.methods.length || runtime.methods.some((method) => !WINDOWS_CATALOG_METHODS.has(method))) {
    throw new CuaControlError("protocol_invalid");
  }
  if (runtime.desktop !== undefined) {
    const desktop = assertRecord(runtime.desktop, ["available", "inputRouting", "compatibility", "coordinateSpace"]);
    if (desktop.available !== true || desktop.inputRouting !== "foreground" || desktop.compatibility !== "development" ||
        desktop.coordinateSpace !== "desktop-image-pixels") throw new CuaControlError("protocol_invalid");
  }
  return structuredClone(catalog);
}

export function validateWindowsTarget(value, complete = false) {
  const target = assertRecord(value, ["appId", "pid", "instanceId", "windowId", "region", "topologyVersion"],
    complete ? ["appId", "pid", "instanceId"] : ["appId", "pid"]);
  assertString(target.appId, 2048);
  integer(target.pid);
  if (target.instanceId !== undefined) assertString(target.instanceId, 256);
  if (target.windowId !== undefined) integer(target.windowId);
  if (target.topologyVersion !== undefined) assertString(target.topologyVersion, 256);
  if (target.region !== undefined) {
    const region = assertRecord(target.region, ["x", "y", "width", "height"]);
    for (const key of ["x", "y"]) integer(region[key], -Number.MAX_SAFE_INTEGER);
    for (const key of ["width", "height"]) integer(region[key], 1, 100_000);
  }
  return structuredClone(target);
}

/** Private wire fields are never accepted by the public Computer Use SDK. */
export function validateWindowsRequest(value, channel = "data") {
  const request = assertRecord(value, ["schemaVersion", "id", "method", "params"]);
  if (request.schemaVersion !== WINDOWS_NATIVE_PROTOCOL || !["data", "control"].includes(channel)) {
    throw new CuaControlError("invalid_request");
  }
  assertString(request.id, 128);
  const control = ["authenticate", "lease", "stop", "close", "desktop_scope"];
  if (control.includes(request.method) !== (channel === "control")) throw new CuaControlError("invalid_request");
  const params = request.params;
  switch (request.method) {
    case "hello":
      assertRecord(params, ["secret", "nonce", "parentPid", "parentImageSha256"]);
      hex(params.secret); hex(params.nonce); hex(params.parentImageSha256); integer(params.parentPid);
      break;
    case "authenticate":
      assertRecord(params, ["secret", "nonce"]); hex(params.secret); hex(params.nonce);
      break;
    case "status": case "credential_ui_status": case "close": case "desktop_displays":
      assertRecord(params, []);
      break;
    case "desktop_scope":
      assertRecord(params, ["scopeId", "displayId", "epoch"]); assertString(params.scopeId, 128); assertString(params.displayId, 128); integer(params.epoch);
      break;
    case "lease":
      assertRecord(params, ["epoch", "ttlMs"]); integer(params.epoch); integer(params.ttlMs, 1, CUA_LIMITS.leaseTtlMs);
      break;
    case "stop":
      assertRecord(params, ["epoch"]); integer(params.epoch, 0);
      break;
    case "resolve_target":
      assertRecord(params, ["target"]); validateWindowsTarget(params.target);
      break;
    case "installed_application":
      assertRecord(params, ["appId"]); assertString(params.appId, 2048);
      break;
    case "open_application_ui":
      assertRecord(params, ["appId", "epoch"]); assertString(params.appId, 2048); integer(params.epoch);
      break;
    case "reserve_action":
      assertRecord(params, ["actionDigest", "epoch", "ttlMs"]);
      hex(params.actionDigest); integer(params.epoch); integer(params.ttlMs, 1, WINDOWS_RESERVATION_TTL_MS);
      break;
    case "execute":
      assertRecord(params, ["payload", "mac"]); hex(params.mac);
      validateWindowsExecutionPayload(params.payload);
      break;
    case "preview_application_ui":
      assertRecord(params, ["target"]); validateWindowsTarget(params.target, true);
      break;
    case "application_window_ui":
      assertRecord(params, ["target", "mode"]); validateWindowsTarget(params.target, true);
      if (!["read", "show", "handover", "background"].includes(params.mode)) throw new CuaControlError("invalid_request");
      break;
    default: throw new CuaControlError("invalid_request", "Unsupported Windows native method.");
  }
  return structuredClone(request);
}

export function validateWindowsExecutionPayload(text) {
  assertString(text, CUA_LIMITS.requestBytes);
  const value = assertRecord(parseWindowsJson(text, CUA_LIMITS.requestBytes),
    ["reservationId", "actionJson", "actionDigest", "epoch", "revision", "callId", "target", "observationId", "desktopScope"],
    ["reservationId", "actionJson", "actionDigest", "epoch", "revision", "callId"]);
  assertString(value.reservationId, 128); hex(value.actionDigest); integer(value.epoch); integer(value.revision, 0);
  assertString(value.callId, 128); assertString(value.actionJson, CUA_LIMITS.requestBytes);
  const decoded = parseWindowsJson(value.actionJson, CUA_LIMITS.requestBytes);
  const action = decoded?.schemaVersion === 2 ? validateWindowsDesktopAction(decoded) : validateControlAction(decoded);
  if (action.schemaVersion === 2) {
    assertString(value.desktopScope, 128);
    if (value.target !== undefined || value.observationId !== undefined) throw new CuaControlError("invalid_request");
  } else if (value.desktopScope !== undefined) throw new CuaControlError("invalid_request");
  if (value.actionJson !== canonicalAction(action) || action.params.approvalId !== undefined) throw new CuaControlError("invalid_request");
  if (value.target !== undefined) validateWindowsTarget(value.target, true);
  if (value.observationId !== undefined) assertString(value.observationId, 128);
  if (text !== canonicalAction(value)) throw new CuaControlError("invalid_request");
  return value;
}

export function validateWindowsStatus(value) {
  const status = assertRecord(value, ["platform", "arch", "osBuild", "nativeProtocolVersion", "engineInstanceId",
    "helperPid", "interactiveDesktop", "capabilities", "hostRole", "desktopInterrupted"],
    ["platform", "arch", "osBuild", "nativeProtocolVersion", "engineInstanceId", "helperPid", "interactiveDesktop", "capabilities", "hostRole"]);
  if (status.platform !== "win32" || !["x64", "arm64"].includes(status.arch) || status.nativeProtocolVersion !== WINDOWS_NATIVE_PROTOCOL ||
      typeof status.interactiveDesktop !== "boolean" || !["prototype-image", "electron-main"].includes(status.hostRole)) throw new CuaControlError("protocol_invalid");
  integer(status.helperPid); integer(status.osBuild); assertString(status.engineInstanceId, 128);
  if (status.desktopInterrupted !== undefined && typeof status.desktopInterrupted !== "boolean") throw new CuaControlError("protocol_invalid");
  if (!Array.isArray(status.capabilities) || status.capabilities.length > INPUT_ROUTES.size ||
      new Set(status.capabilities).size !== status.capabilities.length || status.capabilities.some((route) => !INPUT_ROUTES.has(route))) {
    throw new CuaControlError("protocol_invalid");
  }
  if (status.capabilities.includes("win32-send-input") && typeof status.desktopInterrupted !== "boolean") {
    throw new CuaControlError("protocol_invalid");
  }
  return structuredClone(status);
}

export function validateWindowsHello(value, { nonce, helperPid, arch }) {
  const result = assertRecord(value, ["status", "nonce", "controlPipe"]);
  const status = validateWindowsStatus(result.status);
  if (result.nonce !== nonce || result.controlPipe !== `\\\\.\\pipe\\fcode-cua-${nonce}` || status.helperPid !== helperPid || status.arch !== arch) {
    throw new CuaControlError("identity_invalid");
  }
  return { ...result, status };
}

export function validateWindowsResponse(value) {
  const response = assertRecord(value, ["schemaVersion", "id", "result", "error"], ["schemaVersion", "id"]);
  if (response.schemaVersion !== WINDOWS_NATIVE_PROTOCOL || Object.hasOwn(response, "result") === Object.hasOwn(response, "error")) {
    throw new CuaControlError("protocol_invalid");
  }
  assertString(response.id, 128);
  if (response.error !== undefined) {
    const error = assertRecord(response.error, ["code", "message"]);
    if (typeof error.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code)) throw new CuaControlError("protocol_invalid");
    assertString(error.message, 1024);
  } else assertRecord(response.result, Object.keys(response.result ?? {}), []);
  return response;
}

/** JSON.parse accepts duplicate keys. Reject them before decoding authenticated messages. */
export function parseWindowsJson(text, byteLimit = CUA_LIMITS.responseBytes) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > byteLimit) throw new CuaControlError("resource_limit");
  let offset = 0;
  const space = () => { while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++; };
  const fail = () => { throw new CuaControlError("protocol_invalid"); };
  const string = () => {
    const start = offset;
    if (text[offset++] !== '"') fail();
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") { offset++; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { fail(); }
      }
    }
    fail();
  };
  const item = (depth) => {
    if (depth > WINDOWS_JSON_DEPTH) fail();
    space();
    const first = text[offset];
    if (first === '"') { string(); return; }
    if (first === "{" || first === "[") {
      const object = first === "{";
      const close = object ? "}" : "]";
      const keys = new Set();
      offset++; space();
      if (text[offset] === close) { offset++; return; }
      while (offset < text.length) {
        if (object) {
          space(); const key = string();
          if (keys.has(key)) fail();
          keys.add(key); space(); if (text[offset++] !== ":") fail();
        }
        item(depth + 1); space();
        if (text[offset] === close) { offset++; return; }
        if (text[offset++] !== ",") fail();
      }
      fail();
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    if (offset === start) fail();
  };
  item(0); space(); if (offset !== text.length) fail();
  try { return JSON.parse(text); } catch { return fail(); }
}
