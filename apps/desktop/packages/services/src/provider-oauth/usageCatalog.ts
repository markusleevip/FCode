import { FCODE_VERSION } from "@fcode/shared";
import type { ProviderOAuthUsageView, ProviderOAuthUsageWindow } from "./contract.js";
import { CLINE_API_BASE_URL, formatClineApiToken } from "./clineCredentials.js";
import { queryCodexResetCredits, readCodexSubscriptionRenewal } from "./codexResetCredits.js";
import { fetchAntigravityModelsPayload } from "./modelCatalog.js";
import { object, string, ProviderOAuthTransport, type OAuthObject } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";

// 额度接口均为厂商未公开的内部接口；解析保持宽松，缺失字段只丢弃对应窗口。
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_WINDOWS = 256;

/** 使用 Host 的既有网络入口；账号刷新、复核与缓存由 ProviderOAuthRuntime 持有。 */
export function createProviderOAuthUsageQuery(options: { fetch: typeof fetch }) {
  const transport = new ProviderOAuthTransport(options.fetch);
  return async (
    account: ProviderOAuthAccount,
    signal: AbortSignal,
  ): Promise<Omit<ProviderOAuthUsageView, "accountId" | "fetchedAt">> => {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    if (account.supplier === "codex") return queryCodexUsage(transport, account, signal);
    if (account.supplier === "antigravity")
      return queryAntigravityUsage(transport, account, signal);
    if (account.supplier === "cline") return queryClineUsage(transport, account, signal);
    throw new ProviderOAuthError("unsupported_usage");
  };
}

async function queryCodexUsage(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  signal: AbortSignal,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.tokens.accessToken}`,
    "user-agent": `FCode/${FCODE_VERSION}`,
    originator: "fcode",
  };
  if (account.tokens.accountIdentity)
    headers["ChatGPT-Account-Id"] = account.tokens.accountIdentity;
  const payload = await transport.request(CODEX_USAGE_URL, { method: "GET", headers }, signal);
  const usage = projectCodexUsage(payload);
  // Reset credits are an extra: a failed lookup must not hide the usage windows.
  const resetCredits = await queryCodexResetCredits(transport, account, signal).catch(() => {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    return undefined;
  });
  const renewsAt = readCodexSubscriptionRenewal(account.tokens.idToken);
  return {
    ...usage,
    ...(resetCredits ? { resetCredits } : {}),
    ...(renewsAt !== undefined ? { renewsAt } : {}),
  };
}

export function projectCodexUsage(payload: OAuthObject) {
  const limit = object(payload.rate_limit);
  const windows: ProviderOAuthUsageWindow[] = [];
  for (const id of ["primary_window", "secondary_window"] as const) {
    const window = projectCodexWindow(id, object(limit[id]));
    if (window) windows.push(window);
  }
  const plan = string(payload.plan_type);
  return { ...(plan ? { plan } : {}), windows };
}

function projectCodexWindow(id: string, value: OAuthObject): ProviderOAuthUsageWindow | undefined {
  const used = finite(value.used_percent);
  if (used === undefined) return undefined;
  const seconds = finite(value.limit_window_seconds);
  const resetAt = finite(value.reset_at);
  const resetAfter = finite(value.reset_after_seconds);
  const resetsAt =
    resetAt !== undefined && resetAt > 0
      ? resetAt * 1000
      : resetAfter !== undefined && resetAfter >= 0
        ? Date.now() + resetAfter * 1000
        : undefined;
  return {
    id,
    usedPercent: clampPercent(used),
    ...(seconds !== undefined && seconds > 0 ? { windowSeconds: seconds } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

async function queryAntigravityUsage(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  signal: AbortSignal,
) {
  const payload = await fetchAntigravityModelsPayload(transport, account.tokens, signal);
  return projectAntigravityUsage(payload);
}

export function projectAntigravityUsage(payload: OAuthObject) {
  const entries = Object.entries(object(payload.models));
  if (entries.length > 4096) throw new ProviderOAuthError("invalid_response");
  const windows: ProviderOAuthUsageWindow[] = [];
  for (const [id, raw] of entries) {
    // 内部补全模型与目录过滤保持一致，不向用户展示。
    if (/^(chat_|tab_)/.test(id)) continue;
    const model = object(raw);
    const quota = object(model.quotaInfo);
    const fraction = finite(quota.remainingFraction);
    const reset = string(quota.resetTime);
    const resetsAt = reset ? Date.parse(reset) : NaN;
    // 额度耗尽时上游可能省略 remainingFraction，只保留重置时间。
    if (fraction === undefined && !Number.isFinite(resetsAt)) continue;
    windows.push({
      id,
      label: string(model.displayName) ?? id,
      usedPercent: clampPercent((1 - (fraction ?? 0)) * 100),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return { windows };
}

const CLINE_WINDOW_SECONDS: Readonly<Record<string, number>> = {
  five_hour: 5 * 3600,
  weekly: 7 * 86_400,
  // Calendar months vary; the UI labels any 28–31 day window as monthly.
  monthly: 30 * 86_400,
};

async function queryClineUsage(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  signal: AbortSignal,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${formatClineApiToken(account.tokens.accessToken)}`,
    "user-agent": `FCode/${FCODE_VERSION}`,
  };
  const limits = await transport.request(
    `${CLINE_API_BASE_URL}/users/me/plan/usage-limits`,
    { method: "GET", headers },
    signal,
  );
  // The plan name is display-only; a failed lookup must not hide the usage windows.
  const plan = await transport
    .request(`${CLINE_API_BASE_URL}/users/me/plan`, { method: "GET", headers }, signal)
    .then(
      (payload) => string(object(object(payload.data).plan).displayName),
      () => {
        if (signal.aborted) throw new ProviderOAuthError("cancelled");
        return undefined;
      },
    );
  return projectClineUsage(limits, plan);
}

export function projectClineUsage(payload: OAuthObject, plan?: string) {
  const entries = object(payload.data).limits;
  const windows: ProviderOAuthUsageWindow[] = [];
  for (const raw of Array.isArray(entries) ? entries.slice(0, MAX_WINDOWS) : []) {
    const entry = object(raw);
    const type = string(entry.type);
    const used = finite(entry.percentUsed);
    if (!type || used === undefined) continue;
    const resetsAt = Date.parse(string(entry.resetsAt) ?? "");
    const seconds = CLINE_WINDOW_SECONDS[type];
    windows.push({
      id: type,
      usedPercent: clampPercent(used),
      ...(seconds !== undefined ? { windowSeconds: seconds } : {}),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    });
  }
  return { ...(plan ? { plan } : {}), windows };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
