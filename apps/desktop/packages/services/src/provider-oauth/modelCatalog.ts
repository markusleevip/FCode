// Catalog protocols and presets adapted from CLIProxyAPI (MIT). See third-party/copied-components.json.
import presets from "./modelPresets.json" with { type: "json" };
import {
  CODEX_CLIENT_ONLY_REASONING_LEVELS,
  type ProviderAccountSupplier,
  type ProviderOAuthModel,
} from "./contract.js";
import { FCODE_VERSION } from "@fcode/shared";
import { hostname } from "node:os";
import { ProviderOAuthTransport, type OAuthObject } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";
import { metaApiBaseUrl } from "./metaCredentials.js";
import { CLINE_API_BASE_URL } from "./clineCredentials.js";
import { queryDevinCatalog } from "./devinCatalog.js";
import { antigravityHostHeaders } from "./antigravityProfile.js";
import type { ProviderOAuthTokens } from "./types.js";

const ACCOUNT_CATALOGS = new Set<ProviderAccountSupplier>([
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "claude",
  "meta",
  "xai",
  "devin",
  "cline",
]);
// Codex 模型目录按 client_version 过滤，落后于官方 CLI 时新模型（如 GPT-6.1 Sol）会被隐藏；
// 官方发布新版本后需同步（npm: @openai/codex 的 latest）。
const CODEX_CLIENT_VERSION = "0.160.0";

/** 来源描述查询能力，不以目录查询成功推断实际调用权限。 */
export function getProviderOAuthModelCatalogSource(
  supplier: ProviderAccountSupplier,
): ProviderOAuthModel["source"] {
  return ACCOUNT_CATALOGS.has(supplier) ? "account" : "preset";
}

/** 使用 Host 的既有网络入口；账号刷新、存储和成员写入分别由原 owner 持有。 */
export function createProviderOAuthModelCatalog(options: { fetch: typeof fetch }) {
  const transport = new ProviderOAuthTransport(options.fetch);
  return async (
    account: ProviderOAuthAccount,
    signal: AbortSignal,
  ): Promise<readonly ProviderOAuthModel[]> => {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    if (getProviderOAuthModelCatalogSource(account.supplier) === "preset")
      return getProviderOAuthPresetModels(account.supplier);
    const headers: Record<string, string> = {
      authorization: `Bearer ${account.tokens.accessToken}`,
      "user-agent": `FCode/${FCODE_VERSION}`,
    };
    if (account.supplier === "claude") return queryClaudeModels(transport, headers, signal);
    if (account.supplier === "devin")
      return projectModels(await queryDevinCatalog(transport, account, signal), "id", "name");
    if (account.supplier === "xai") {
      const payload = await transport.request(
        "https://cli-chat-proxy.grok.com/v1/models",
        {
          method: "GET",
          headers: {
            ...headers,
            "X-XAI-Token-Auth": "xai-grok-cli",
            "x-grok-client-version": FCODE_VERSION,
            "x-grok-client-identifier": "fcode",
            "x-grok-client-mode": "interactive",
            ...(account.tokens.accountIdentity
              ? { "x-userid": account.tokens.accountIdentity }
              : {}),
            ...(account.tokens.email ? { "x-email": account.tokens.email } : {}),
          },
        },
        signal,
      );
      return projectXaiModels(payload);
    }
    if (account.supplier === "cline") {
      // Account models: pay-as-you-go recommendations, free models and Cline Pass models (cline-pass/*).
      const payload = await transport.request(
        `${CLINE_API_BASE_URL}/ai/cline/recommended-models`,
        { method: "GET", headers },
        signal,
      );
      const seen = new Set<string>();
      const values = [payload.recommended, payload.free, payload.clinePass].flatMap((group) =>
        group === undefined ? [] : collection(group),
      );
      // cline-free/* is rejected with HTTP 403 ("only available via Cline product surfaces") for any
      // third-party client, so it is never offered.
      return projectModels(
        values.filter((value) => {
          const id = record(value).id;
          if (typeof id !== "string" || id.startsWith("cline-free/") || seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
        "id",
        "name",
      );
    }
    if (account.supplier === "meta") {
      const payload = await transport.request(
        `${metaApiBaseUrl(account.tokens.apiBaseUrl)}/models`,
        { method: "GET", headers },
        signal,
      );
      if (payload.object !== "list") throw new ProviderOAuthError("invalid_model_catalog");
      const values = collection(payload.data);
      for (const value of values)
        if (record(value).object !== "model") throw new ProviderOAuthError("invalid_model_catalog");
      return projectModels(values, "id", "id");
    }
    let payload: OAuthObject;
    if (account.supplier === "codex") {
      headers.originator = "fcode";
      if (account.tokens.accountIdentity)
        headers["ChatGPT-Account-Id"] = account.tokens.accountIdentity;
      payload = await transport.request(
        `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
        { method: "GET", headers },
        signal,
      );
      return projectModels(collection(payload.models), "slug", "display_name", { codex: true });
    }
    if (account.supplier === "antigravity") {
      return queryAntigravityModels(transport, account.tokens, signal);
    }
    if (account.supplier !== "kimi" && account.supplier !== "kimi-ai")
      throw new ProviderOAuthError("invalid_supplier");
    Object.assign(headers, {
      "X-Msh-Platform": "FCode",
      "X-Msh-Version": FCODE_VERSION,
      "X-Msh-Device-Name": hostname(),
      "X-Msh-Device-Model": `${process.platform}/${process.arch}`,
      ...(account.tokens.deviceId ? { "X-Msh-Device-Id": account.tokens.deviceId } : {}),
    });
    const host = account.supplier === "kimi" ? "api.kimi.com" : "api.kimi.ai";
    payload = await transport.request(
      `https://${host}/coding/v1/models`,
      { method: "GET", headers },
      signal,
    );
    return projectModels(collection(payload.data), "id", "display_name");
  };
}

function projectXaiModels(payload: OAuthObject): readonly ProviderOAuthModel[] {
  const values = collection(payload.data).flatMap((value) => {
    const model = record(value);
    const meta = model._meta == null ? {} : record(model._meta);
    const hidden = model.hidden ?? meta.hidden;
    if (hidden !== undefined && typeof hidden !== "boolean")
      throw new ProviderOAuthError("invalid_model_catalog");
    if (hidden) return [];
    // 展示别名不能直接作为调用名称；OAuth 可见性也不能套用 API key 的 supported_in_api 限制。
    const id = text(
      model.model ?? model.modelId ?? model.id ?? meta.model ?? meta.modelId,
      256,
      true,
    );
    return [{ ...model, id, name: model.name ?? id }];
  });
  return projectModels(values, "id", "name");
}

async function queryClaudeModels(
  transport: ProviderOAuthTransport,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<readonly ProviderOAuthModel[]> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const values: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 64; page++) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
      const payload = await transport.request(
        url.toString(),
        {
          method: "GET",
          headers: {
            ...headers,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
          },
        },
        boundedSignal,
      );
      const entries = collection(payload.data);
      if (
        entries.length > 1000 ||
        values.length + entries.length > 4096 ||
        typeof payload.has_more !== "boolean"
      )
        throw new ProviderOAuthError("invalid_model_catalog");
      values.push(...entries);
      if (!payload.has_more) return projectModels(values, "id", "display_name");
      cursor = text(payload.last_id, 256, true);
      if (
        !entries.length ||
        text(record(entries.at(-1)).id, 256, true) !== cursor ||
        cursors.has(cursor)
      )
        throw new ProviderOAuthError("invalid_model_catalog");
      cursors.add(cursor);
    }
    throw new ProviderOAuthError("invalid_model_catalog");
  } catch (error) {
    // 分页总期限不能逐页续期；内部超时保持网络失败语义，用户取消仍单独返回。
    if (boundedSignal.aborted && !signal.aborted) throw new ProviderOAuthError("network_error");
    throw error;
  }
}

function record(value: unknown): OAuthObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderOAuthError("invalid_model_catalog");
  return value as OAuthObject;
}

function collection(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new ProviderOAuthError("invalid_model_catalog");
  return value;
}

function text(value: unknown, max: number, id = false): string {
  if (typeof value !== "string") throw new ProviderOAuthError("invalid_model_catalog");
  const result = value.trim();
  if (
    !result ||
    result.length > max ||
    Array.from(result).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (id && /\s/.test(result))
  )
    throw new ProviderOAuthError("invalid_model_catalog");
  return result;
}

function textOutput(model: OAuthObject, id: string): boolean {
  const modalities = model.output_modalities;
  if (modalities !== undefined) {
    if (!Array.isArray(modalities) || modalities.some((value) => typeof value !== "string"))
      throw new ProviderOAuthError("invalid_model_catalog");
    if (!modalities.includes("text")) return false;
  }
  return !/(?:^|[-_.])(image|audio|tts|embeddings?)(?:[-_.]|$)/i.test(id);
}

function projectModels(
  values: unknown[],
  idKey: string,
  nameKey: string,
  profile: { codex?: boolean; antigravity?: boolean } = {},
): readonly ProviderOAuthModel[] {
  const models = new Map<string, ProviderOAuthModel>();
  for (const value of values) {
    const model = record(value);
    if (
      profile.codex &&
      (model.visibility === "hide" ||
        model.visibility === "hidden" ||
        model.show_in_picker === false ||
        model.supported_in_api === false)
    )
      continue;
    const id = text(model[idKey], 256, true);
    // 内部补全名称属于 Antigravity 协议；不能套用到其他厂商的新模型 ID。
    if (profile.antigravity && /^(chat_|tab_)/.test(id)) continue;
    if (!textOutput(model, id)) continue;
    const name = model[nameKey] == null ? id : text(model[nameKey], 512);
    const reasoningLevels = profile.codex ? codexReasoningLevels(model) : undefined;
    const supportsImage = profile.codex
      ? codexSupportsImage(model)
      : profile.antigravity
        ? antigravitySupportsImage(model)
        : undefined;
    if (!models.has(id))
      models.set(id, {
        id,
        name,
        source: "account",
        ...(reasoningLevels ? { reasoningLevels } : {}),
        ...(supportsImage !== undefined ? { supportsImage } : {}),
      });
  }
  if (!models.size) throw new ProviderOAuthError("empty_model_catalog");
  return [...models.values()];
}

// 目录是模型输入能力的事实来源；内置规则表只覆盖已知型号，新模型否则会落到“无视觉”默认值。
function codexSupportsImage(model: OAuthObject): boolean | undefined {
  const modalities = model.input_modalities;
  if (!Array.isArray(modalities) || modalities.some((value) => typeof value !== "string"))
    return undefined;
  return modalities.includes("image");
}

// Antigravity 目录逐模型声明 supportsImages；旧响应只给 supportedMimeTypes（MIME → 是否支持）。
function antigravitySupportsImage(model: OAuthObject): boolean | undefined {
  if (typeof model.supportsImages === "boolean") return model.supportsImages;
  const mimeTypes = model.supportedMimeTypes;
  if (!mimeTypes || typeof mimeTypes !== "object" || Array.isArray(mimeTypes)) return undefined;
  const entries = Object.entries(mimeTypes as Record<string, unknown>);
  if (!entries.length) return undefined;
  return entries.some(([type, supported]) => supported === true && type.startsWith("image/"));
}

function codexReasoningLevels(model: OAuthObject): readonly string[] | undefined {
  if (model.supported_reasoning_levels === undefined) return undefined;
  const entries = collection(model.supported_reasoning_levels);
  if (!entries.length || entries.length > 16) throw new ProviderOAuthError("invalid_model_catalog");
  const levels = entries.map((entry) => text(record(entry).effort, 64, true));
  if (new Set(levels).size !== levels.length) throw new ProviderOAuthError("invalid_model_catalog");
  // 修复依据：Codex 模型目录按模型返回档位，丢掉该字段会退回通用 none/enabled。
  // 目录同时列出客户端专属模式（ultra 等），它们不是 API 取值；过滤后其余档位仍原样保留，
  // API 日后新增的普通档位无需改代码。
  const apiLevels = levels.filter((level) => !CODEX_CLIENT_ONLY_REASONING_LEVELS.includes(level));
  return apiLevels.length ? apiLevels : undefined;
}

export function getProviderOAuthPresetModels(
  supplier: ProviderAccountSupplier,
): readonly ProviderOAuthModel[] {
  return presets[supplier].map(({ id, name }) => ({ id, name, source: "preset" }));
}

/** 模型目录与额度查询共用同一个上游请求。 */
export async function fetchAntigravityModelsPayload(
  transport: ProviderOAuthTransport,
  tokens: Pick<ProviderOAuthTokens, "accessToken" | "projectId">,
  signal: AbortSignal,
): Promise<OAuthObject> {
  if (!tokens.projectId) throw new ProviderOAuthError("missing_project");
  return transport.json(
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    { project: tokens.projectId },
    signal,
    { authorization: `Bearer ${tokens.accessToken}`, ...antigravityHostHeaders() },
  );
}

/** 账号目录与用户项目验证共用这一条查询/校验路径，空目录不代表项目可用。 */
export async function queryAntigravityModels(
  transport: ProviderOAuthTransport,
  tokens: Pick<ProviderOAuthTokens, "accessToken" | "projectId">,
  signal: AbortSignal,
): Promise<readonly ProviderOAuthModel[]> {
  const payload = await fetchAntigravityModelsPayload(transport, tokens, signal);
  const entries = Object.entries(record(payload.models));
  if (entries.length > 4096) throw new ProviderOAuthError("invalid_model_catalog");
  return projectModels(
    entries.map(([id, value]) => ({ ...record(value), id })),
    "id",
    "displayName",
    { antigravity: true },
  );
}
