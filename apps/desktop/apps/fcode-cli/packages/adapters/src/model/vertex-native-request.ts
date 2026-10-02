// Vertex wire profile adapted from CLIProxyAPI Gemini Vertex executor (MIT).
import { VERTEX_NATIVE_PROJECT_HEADER, VERTEX_NATIVE_LOCATION_HEADER } from "@fcode/shared";
import {
  geminiFailure,
  geminiRecord,
  geminiNativeTools,
  type NativeRecord,
} from "./gemini-native-tools.js";
import { geminiNativeHistory } from "./gemini-native-history.js";

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{3,62}$/;
const LOCATION_PATTERN = /^(global|[a-z]+(?:-[a-z]+)+[0-9])$/;
const MODEL_PATTERN = /^gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
export function prepareVertexRequest(body: NativeRecord, headers: Headers, token: string) {
  const project = headers.get(VERTEX_NATIVE_PROJECT_HEADER)?.trim();
  const location = headers.get(VERTEX_NATIVE_LOCATION_HEADER)?.trim();
  headers.delete(VERTEX_NATIVE_PROJECT_HEADER);
  headers.delete(VERTEX_NATIVE_LOCATION_HEADER);
  if (!project || !PROJECT_PATTERN.test(project))
    geminiFailure("Vertex requires a valid selected project", true);
  if (!location || !LOCATION_PATTERN.test(location))
    geminiFailure("Vertex requires a valid selected location", true);
  const model = typeof body.model === "string" ? body.model.replace(/\[1m\]$/, "") : "";
  if (!MODEL_PATTERN.test(model)) geminiFailure("Vertex model is unsupported or invalid", true);
  const symbols = geminiNativeTools(body, "vertex");
  const history = geminiNativeHistory(body, model, symbols.alias, "vertex");
  // Vertex 不接受客户端生成的调用 ID；仅删除 wire 字段，SDK 历史中的调用关联保持不变。
  for (const content of history.contents)
    for (const part of content.parts as NativeRecord[]) {
      const call = geminiRecord(part.functionCall),
        result = geminiRecord(part.functionResponse);
      if (call) delete call.id;
      if (result) delete result.id;
    }
  const generationConfig: NativeRecord = {};
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["max_tokens", "maxOutputTokens"],
  ]) {
    if (body[from] === undefined) continue;
    if (typeof body[from] !== "number" || !Number.isFinite(body[from]))
      geminiFailure("Vertex generation setting is invalid", true);
    generationConfig[to] = body[from];
  }
  const thinking = geminiRecord(body.thinking),
    effort = body.reasoning_effort ?? geminiRecord(body.output_config)?.effort;
  if (thinking?.type === "enabled") {
    if (
      typeof thinking.budget_tokens !== "number" ||
      !Number.isSafeInteger(thinking.budget_tokens) ||
      thinking.budget_tokens < 0
    )
      geminiFailure("Vertex thinking budget is invalid", true);
    generationConfig.thinkingConfig = {
      thinkingBudget: thinking.budget_tokens,
      includeThoughts: true,
    };
  } else if (thinking?.type === "adaptive" || thinking?.type === "auto" || effort)
    generationConfig.thinkingConfig = { thinkingLevel: effort ?? "high", includeThoughts: true };
  const format = geminiRecord(geminiRecord(body.output_config)?.format);
  if (format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = format.schema;
  }
  const choice = geminiRecord(body.tool_choice),
    mode = choice?.type ?? "auto";
  if (!["auto", "none", "any", "tool"].includes(String(mode)))
    geminiFailure("Vertex tool choice is unsupported", true);
  const functionCallingConfig: NativeRecord = {
    mode: mode === "none" ? "NONE" : mode === "any" || mode === "tool" ? "ANY" : "AUTO",
  };
  if (mode === "tool") {
    if (typeof choice?.name !== "string")
      geminiFailure("Vertex forced tool choice requires a name", true);
    functionCallingConfig.allowedFunctionNames = [symbols.alias(choice.name)];
  }
  if (mode === "tool" || mode === "any") delete generationConfig.thinkingConfig;
  const request = {
    ...history,
    generationConfig,
    ...(symbols.tools.length
      ? { tools: symbols.tools, toolConfig: { functionCallingConfig } }
      : {}),
  };
  for (const key of [
    "x-api-key",
    "x-goog-api-key",
    "anthropic-version",
    "anthropic-beta",
    "content-length",
  ])
    headers.delete(key);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return {
    model,
    body: request,
    original: symbols.original,
    target(url: URL) {
      const host =
        location === "global"
          ? "aiplatform.googleapis.com"
          : `${location}-aiplatform.googleapis.com`;
      if (
        url.protocol !== "https:" ||
        url.hostname !== host ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        geminiFailure("Vertex endpoint does not match the selected account location", true);
      url.pathname = `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent`;
      url.search = "?alt=sse";
      return url;
    },
  };
}
