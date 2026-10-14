export const CUA_PROTOCOL_VERSION = 1;
export const CUA_OFFICIAL_PLUGIN_ID = "computer-use@fcode-plugins-official";
export const CUA_LIMITS = Object.freeze({
  requestBytes: 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  textBytes: 16 * 1024,
  imageEdge: 1600,
  elementCount: 300,
  frameTtlMs: 15_000,
  callTtlMs: 120_000,
  leaseTtlMs: 10_000,
  heartbeatMs: 2_000,
  actionTimeoutMs: 10_000,
  queueSize: 16,
  resultCount: 512,
  approvalCount: 32,
  approvalTtlMs: 120_000,
});

export class CuaControlError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "CuaControlError";
    this.code = code;
    const safe = controlErrorDetails(details);
    Object.assign(this, safe);
  }
}

const ERROR_STAGES = ["selection", "host", "transport", "native", "execute"];
const ERROR_REASONS = ["task_not_selected", "task_inactive", "invocation_expired", "host_transport_unavailable",
  "helper_missing", "permission_required", "secure_input_active", "protocol_mismatch", "model_failed"];
export function controlErrorDetails(value) {
  const result = {};
  if (ERROR_STAGES.includes(value?.stage)) result.stage = value.stage;
  if (ERROR_REASONS.includes(value?.reason)) result.reason = value.reason;
  for (const key of ["retryable", "requiresUserAction"]) if (typeof value?.[key] === "boolean") result[key] = value[key];
  return result;
}

export function assertRecord(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CuaControlError("invalid_request", "Expected an object.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !fields.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new CuaControlError("invalid_request", "Request fields do not match the protocol.");
  }
  return value;
}

export function assertString(value, maxLength = CUA_LIMITS.textBytes) {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > maxLength) {
    throw new CuaControlError("invalid_request", "Invalid string value.");
  }
  return value;
}

function number(value, integer = false, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new CuaControlError("invalid_request", "Invalid numeric value.");
  }
}

const target = ["appId", "pid", "windowId"];
const METHODS = Object.freeze({
  list_apps: { fields: [], required: [], input: false },
  open_browser: { fields: ["url", "appId", "pid"], required: ["url"], input: true },
  open_application: { fields: ["appId", "pid"], required: ["appId"], input: true },
  list_windows: { fields: ["appId", "pid"], required: ["appId", "pid"], input: false },
  capture: { fields: target, required: target, input: false },
  get_app_state: { fields: target, required: target, input: false },
  activate_window: { fields: target, required: target, input: true },
  click: { fields: ["frameId", "x", "y", "button", "count"], required: ["frameId", "x", "y"], input: true },
  move: { fields: ["frameId", "x", "y"], required: ["frameId", "x", "y"], input: true },
  drag: { fields: ["frameId", "x", "y", "toX", "toY", "durationMs"], required: ["frameId", "x", "y", "toX", "toY"], input: true },
  scroll: { fields: ["frameId", "x", "y", "deltaX", "deltaY"], required: ["frameId", "x", "y", "deltaY"], input: true },
  type_text: { fields: ["stateId", "text", "elementIndex"], required: ["stateId", "text"], input: true },
  request_credential: { fields: ["stateId", "elementIndex", "origin"], required: ["stateId", "elementIndex", "origin"], input: true },
  type_credential: { fields: ["stateId", "elementIndex", "credentialId"], required: ["stateId", "elementIndex", "credentialId"], input: true },
  press_keys: { fields: ["stateId", "keys"], required: ["stateId", "keys"], input: true },
  element_action: { fields: ["stateId", "elementIndex", "action", "value"], required: ["stateId", "elementIndex", "action"], input: true },
  prepare_input: { fields: ["method", "params"], required: ["method", "params"], input: false },
});

export function isInputMethod(method) {
  return typeof method === "string" && Object.hasOwn(METHODS, method) && METHODS[method].input;
}

export function isControlMethod(method) {
  return typeof method === "string" && Object.hasOwn(METHODS, method);
}

export function validateControlAction(value) {
  const action = assertRecord(value, ["schemaVersion", "actionId", "method", "params"]);
  if (action.schemaVersion !== CUA_PROTOCOL_VERSION || !isControlMethod(action.method)) {
    throw new CuaControlError("invalid_request", "Unsupported protocol version or method.");
  }
  assertString(action.actionId, 128);
  const rule = METHODS[action.method];
  const params = assertRecord(action.params, rule.input ? [...rule.fields, "approvalId"] : rule.fields, rule.required);
  if (action.method === "prepare_input") {
    if (!isInputMethod(params.method) || params.params?.approvalId !== undefined) {
      throw new CuaControlError("invalid_request", "Only a new concrete input may request approval.");
    }
    validateControlAction({ schemaVersion: 1, actionId: action.actionId, method: params.method, params: params.params });
    return structuredClone(action);
  }
  if ("approvalId" in params) assertString(params.approvalId, 128);
  if (action.method === "open_browser") {
    assertString(params.url, 2048);
    let url;
    try { url = new URL(params.url); } catch { throw new CuaControlError("invalid_request", "Invalid browser URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new CuaControlError("invalid_request", "An HTTP(S) URL without embedded credentials is required.");
    }
  }
  if (action.method === "request_credential") {
    assertString(params.origin, 2048);
    let url;
    try { url = new URL(params.origin); } catch { throw new CuaControlError("invalid_request", "Invalid credential origin."); }
    if (url.protocol !== "https:" || url.origin !== params.origin || url.username || url.password) {
      throw new CuaControlError("invalid_request", "A canonical HTTPS origin is required.");
    }
  }
  for (const name of ["appId", "frameId", "stateId", "credentialId", "text", "action", "value"]) {
    if (name in params) assertString(params[name]);
  }
  for (const name of ["pid", "windowId", "elementIndex"]) {
    if (name in params) number(params[name], true, name === "elementIndex" ? 0 : 1);
  }
  for (const name of ["x", "y", "toX", "toY"]) {
    if (name in params) number(params[name], true, 0);
  }
  for (const name of ["deltaX", "deltaY"]) {
    if (name in params) number(params[name], true, -10_000, 10_000);
  }
  if ("durationMs" in params) number(params.durationMs, true, 100, 2_000);
  if ("count" in params) number(params.count, true, 1, 3);
  if ("button" in params && !["left", "right", "middle"].includes(params.button)) {
    throw new CuaControlError("invalid_request", "Unsupported mouse button.");
  }
  if ("keys" in params) {
    if (!Array.isArray(params.keys) || !params.keys.length || params.keys.length > 8) {
      throw new CuaControlError("invalid_request", "Invalid key combination.");
    }
    params.keys.forEach((key) => assertString(key, 32));
  }
  if ("action" in params && !["press", "set_value", "focus"].includes(params.action)) {
    throw new CuaControlError("unsupported_action", "Unsupported element action.");
  }
  if (action.method === "element_action" && (params.action === "set_value") !== ("value" in params)) {
    throw new CuaControlError("invalid_request", "Element value does not match the action.");
  }
  return structuredClone(action);
}

export function canonicalAction(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}
