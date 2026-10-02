import { z } from "zod";

/**
 * 模型目录拉取：按 Provider 的 api.type + baseUrl + apiKey 实时请求网关的模型列表，
 * 不依赖任何预先配置的 builtinModelIds。响应只按 OpenAI / Anthropic 通用的
 * `{ data: [{ id }] }` 形状解析，保证同一实现覆盖 openai-chat-completions、
 * openai-responses 与 anthropic-messages 三种 api 类型。
 */

const MODEL_CATALOG_TIMEOUT_MS = 15_000;

const modelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
    }),
  ),
});

/** 非对话模型（图像/向量化/语音等）不进入编码助手的候选列表；这是保守启发式，网关侧模型仍可在设置页手动补。 */
const NON_CHAT_MODEL_ID_PATTERN = /image|embedding|rerank|whisper|tts|speech|moderation|dall-e/i;

export type ProviderModelCatalogApiType =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export interface FetchProviderModelIdsInput {
  readonly apiType: ProviderModelCatalogApiType;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Anthropic 系挂在 `{base}/v1/models`；OpenAI 兼容系直接挂 `{base}/models`。 */
export function resolveModelCatalogUrl(
  baseUrl: string,
  apiType: ProviderModelCatalogApiType,
): string {
  const base = baseUrl.trim().replace(/\/+$/u, "");
  return apiType === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
}

/**
 * 拉取并规整网关模型 id：保序、去重、剔除明显的非对话模型。
 * 请求失败、响应形状不符或列表为空时抛错，由调用方决定降级策略。
 */
export async function fetchProviderModelIds(input: FetchProviderModelIdsInput): Promise<string[]> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const url = resolveModelCatalogUrl(input.baseUrl, input.apiType);
  const headers =
    input.apiType === "anthropic-messages"
      ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${input.apiKey}` };
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`模型目录请求失败: HTTP ${response.status} (${url})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`模型目录响应不是合法 JSON (${url})`, { cause });
  }
  const parsed = modelsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`模型目录响应缺少 data[].id 字段 (${url})`);
  }
  const modelIds: string[] = [];
  for (const entry of parsed.data.data) {
    const modelId = entry.id.trim();
    if (!modelId || modelIds.includes(modelId) || NON_CHAT_MODEL_ID_PATTERN.test(modelId)) continue;
    modelIds.push(modelId);
  }
  return modelIds;
}
