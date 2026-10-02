// Adapted from CLIProxyAPI Codex Responses request conversion (MIT).
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";

type JsonRecord = Record<string, unknown>;
const UNSUPPORTED_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "truncation",
  "prompt_cache_options",
  "prompt_cache_retention",
  "user",
  "previous_response_id",
  "generate",
  "safety_identifier",
  "stream_options",
] as const;

export function asCodexRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function normalizeCodexRequest(value: JsonRecord): JsonRecord {
  const body = {
    ...value,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
  } as JsonRecord;
  for (const key of UNSUPPORTED_FIELDS) delete body[key];
  if (body.instructions === undefined || body.instructions === null) body.instructions = "";
  if (typeof body.instructions !== "string")
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "Codex instructions must be text",
    );
  if (typeof body.input === "string")
    body.input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: body.input }] },
    ];
  if (!Array.isArray(body.input))
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "Codex requires a complete input history",
    );
  body.input = body.input.map((value) => {
    const input = asCodexRecord(value);
    if (!input) return value;
    // store:false 时引用先前服务端对象会丢历史；SDK 必须发送完整内容，不能伪造恢复结果。
    if (input.type === "item_reference")
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "Codex requires full history instead of stored item references",
      );
    const item = { ...input };
    if (item.role === "system") item.role = "developer";
    if (
      item.type === "function_call" &&
      typeof item.arguments === "string" &&
      !item.arguments.trim()
    )
      item.arguments = "{}";
    delete item.prompt_cache_breakpoint;
    for (const key of ["content", "output"]) {
      if (Array.isArray(item[key]))
        item[key] = item[key].map((part) => {
          const record = asCodexRecord(part);
          if (!record || !("prompt_cache_breakpoint" in record)) return part;
          const result = { ...record };
          delete result.prompt_cache_breakpoint;
          return result;
        });
    }
    return item;
  });
  const tier =
    typeof body.service_tier === "string" ? body.service_tier.trim().toLowerCase() : undefined;
  if (tier === "fast" || tier === "priority") body.service_tier = "priority";
  else if (tier === "ultrafast") body.service_tier = tier;
  else delete body.service_tier;
  if (Array.isArray(body.tools)) body.tools = body.tools.map(normalizeBuiltinTool);
  const choice = asCodexRecord(body.tool_choice);
  if (choice) {
    body.tool_choice = normalizeBuiltinTool(choice);
    if (Array.isArray(choice.tools))
      (body.tool_choice as JsonRecord).tools = choice.tools.map(normalizeBuiltinTool);
  }
  return body;
}

function normalizeBuiltinTool(value: unknown): unknown {
  const record = asCodexRecord(value);
  return record?.type === "web_search_preview" || record?.type === "web_search_preview_2025_03_11"
    ? { ...record, type: "web_search" }
    : value;
}
