// xAI / Meta wire profiles adapted from CLIProxyAPI (MIT).
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import {
  asResponsesRecord as record,
  type ResponsesNativeProfile,
  type ResponsesRecord,
} from "./responses-native-profile.js";
import { createXaiEventNormalizer } from "./xai-native-events.js";

const XAI_PROTOCOL_VERSION = "0.2.120";
const XAI_MAX_TOOLS = 200;
const XAI_REMOVED_FIELDS = [
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "stop",
];
const META_REMOVED_FIELDS = [
  "generate",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "client_metadata",
];

function metaTool(value: unknown): unknown {
  const tool = record(value);
  if (!tool) return value;
  const next = { ...tool };
  if (next.type === "web_search") delete next.search_content_types;
  if (next.type === "namespace" && Array.isArray(next.tools)) next.tools = next.tools.map(metaTool);
  return next;
}

export function normalizeVendorResponsesRequest(
  body: ResponsesRecord,
  supplier: "xai" | "meta",
): ResponsesRecord {
  const next: ResponsesRecord = { ...body, stream: true, store: false };
  delete next.previous_response_id;
  delete next.conversation;
  for (const field of supplier === "xai" ? XAI_REMOVED_FIELDS : META_REMOVED_FIELDS)
    delete next[field];
  next.instructions ??= "";
  // 旧 Chat option-map 只在原生账号边界转换，保留 max_output_tokens 和调用者的 schema。
  next.max_output_tokens ??= next.max_tokens ?? next.max_completion_tokens;
  if (next.max_output_tokens === undefined) delete next.max_output_tokens;
  if (next.reasoning_effort !== undefined)
    next.reasoning = { effort: next.reasoning_effort, ...record(next.reasoning) };
  delete next.max_tokens;
  delete next.max_completion_tokens;
  delete next.reasoning_effort;
  if (Array.isArray(next.tools)) {
    if (supplier === "xai" && next.tools.length > XAI_MAX_TOOLS)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "xAI supports at most 200 tools per request",
      );
    if (supplier === "meta") next.tools = next.tools.map(metaTool);
  }
  return next;
}

export function vendorResponsesProfile(supplier: "xai" | "meta"): ResponsesNativeProfile {
  return {
    supplier,
    normalizeRequest: (body) => normalizeVendorResponsesRequest(body, supplier),
    patchHeaders(headers) {
      headers.set("cache-control", "no-cache");
      if (supplier === "meta") headers.set("x-client-id", "tbh:tui");
      else {
        headers.set("x-xai-token-auth", "xai-grok-cli");
        headers.set("x-grok-client-version", XAI_PROTOCOL_VERSION);
        headers.set("x-grok-client-identifier", "grok-shell");
        headers.set("x-authenticateresponse", "authenticate-response");
      }
    },
    ...(supplier === "xai" ? { createEventNormalizer: createXaiEventNormalizer } : {}),
    normalizeJson(value, body) {
      const raw = record(value);
      const response = raw?.type === "response.completed" ? raw.response : value;
      return supplier === "xai"
        ? createXaiEventNormalizer(body)({ type: "response.completed", response })[0]?.response
        : response;
    },
  };
}
