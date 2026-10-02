// Native envelope/request mapping adapted from CLIProxyAPI (MIT).
import { createHash, randomUUID } from "node:crypto";
import { ANTIGRAVITY_NATIVE_PROJECT_HEADER } from "@fcode/shared";
import { createAntigravityNativeHeaders } from "@fcode/shared/node";
import {
  geminiRecord,
  geminiFailure,
  geminiNativeTools,
  type NativeRecord,
} from "./gemini-native-tools.js";
import { geminiNativeHistory } from "./gemini-native-history.js";
export const ANTIGRAVITY_STREAM_PATH = "/v1internal:streamGenerateContent";
function session(body: NativeRecord): string {
  let id = "";
  const metadata = geminiRecord(body.metadata);
  if (typeof metadata?.user_id === "string") {
    try {
      const record = geminiRecord(JSON.parse(metadata.user_id));
      if (typeof record?.session_id === "string") id = record.session_id;
    } catch {
      geminiFailure("session metadata is invalid", true);
    }
  }
  if (!id) id = randomUUID();
  const hash = createHash("sha256").update(id).digest();
  return "-" + (hash.readBigUInt64BE() % 9000000000000000000n).toString();
}
export function prepareAntigravityRequest(body: NativeRecord, headers: Headers, token: string) {
  const project = headers.get(ANTIGRAVITY_NATIVE_PROJECT_HEADER)?.trim();
  headers.delete(ANTIGRAVITY_NATIVE_PROJECT_HEADER);
  if (
    !project ||
    Array.from(project).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    geminiFailure("requires its selected account project", true);
  if (typeof body.model !== "string" || !body.model) geminiFailure("requires a model", true);
  const model = body.model.replace(/\[1m\]$/, ""),
    symbols = geminiNativeTools(body, "antigravity");
  const generationConfig: NativeRecord = {};
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["max_tokens", "maxOutputTokens"],
  ]) {
    if (body[from] !== undefined) {
      if (typeof body[from] !== "number" || !Number.isFinite(body[from]))
        geminiFailure("generation setting is invalid", true);
      generationConfig[to] = body[from];
    }
  }
  if (!model.includes("claude")) delete generationConfig.maxOutputTokens;
  const thinking = geminiRecord(body.thinking),
    effort = body.reasoning_effort ?? geminiRecord(body.output_config)?.effort;
  if (thinking?.type === "enabled")
    generationConfig.thinkingConfig = {
      thinkingBudget: thinking.budget_tokens,
      includeThoughts: true,
    };
  else if (thinking?.type === "adaptive" || thinking?.type === "auto" || effort)
    generationConfig.thinkingConfig = { thinkingLevel: effort ?? "high", includeThoughts: true };
  const format = geminiRecord(geminiRecord(body.output_config)?.format);
  if (format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = format.schema;
  }
  const choice = geminiRecord(body.tool_choice),
    mode = choice?.type ?? "auto";
  if (!["auto", "none", "any", "tool"].includes(String(mode)))
    geminiFailure("tool choice is unsupported", true);
  const functionCallingConfig: NativeRecord = {
    mode:
      mode === "none"
        ? "NONE"
        : mode === "any" || mode === "tool"
          ? "ANY"
          : model.includes("claude")
            ? "VALIDATED"
            : "AUTO",
  };
  if (mode === "tool") {
    if (typeof choice?.name !== "string") geminiFailure("forced tool choice requires a name", true);
    functionCallingConfig.allowedFunctionNames = [symbols.alias(choice.name)];
  }
  if (mode === "tool" || mode === "any") delete generationConfig.thinkingConfig;
  const request = {
    ...geminiNativeHistory(body, model, symbols.alias, "antigravity"),
    generationConfig,
    sessionId: session(body),
    ...(symbols.tools.length
      ? { tools: symbols.tools, toolConfig: { functionCallingConfig } }
      : {}),
  };
  headers.delete("x-api-key");
  headers.delete("anthropic-version");
  headers.delete("anthropic-beta");
  headers.delete("content-length");
  headers.set("authorization", `Bearer ${token}`);
  // 授权与推理必须协商同一厂商协议；普通产品 UA 会使已授权账号遭到 license 拒绝。
  for (const [name, value] of Object.entries(createAntigravityNativeHeaders()))
    headers.set(name, value);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return {
    model,
    body: {
      model,
      project,
      request,
      requestType: "agent",
      requestId: `agent-${randomUUID()}`,
      userAgent: "antigravity",
    },
    original: symbols.original,
  };
}
