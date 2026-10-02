import type { FCodeEnv } from "./env.js";

export const DEFAULT_FCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";

// 构建仅注入公开链接；Node 调用方仍可显式传 env，避免读取另一进程的配置。
declare const __FCODE_ENDPOINT_ENV__: Record<string, string | undefined> | undefined;
export function pickProductEndpointEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys = [
    "FCODE_BASE_URL",
    "FCODE_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key]!.trim()]] : [])),
  );
}
export function readProductEndpointEnv(): Record<string, string | undefined> {
  return {
    ...(typeof __FCODE_ENDPOINT_ENV__ === "undefined" ? {} : __FCODE_ENDPOINT_ENV__),
    ...pickProductEndpointEnv(typeof process === "undefined" ? {} : process.env),
  };
}

export interface FCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  webShareCallbackUrl: string;
  fcodePlanOpenAiBaseUrl: string;
  fcodePlanAnthropicBaseUrl: string;
  fcodePlanBillingCurrentUrl: string;
  fcodePlanBillingBalanceUrl: string;
}

export interface RuntimeFCodeEndpointEnv {
  [key: string]: string | undefined;
  FCODE_ENV?: string;
  FCODE_BASE_URL?: string;
  FCODE_ENDPOINT_ORIGIN?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  FCODE_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  FCODE_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeFCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  fcodeEnv: FCodeEnv;
  fcodeEndpointOrigin: string;
  fcodeEndpointUrls: FCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function normalizeFCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("FCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("FCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeFCodeEndpointOrigin(value);
    if (
      origin === DEFAULT_FCODE_ENDPOINT_ORIGIN ||
      origin === resolveRuntimeFCodeEndpointOrigin()
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function resolveFCodeEndpointOrigin(options?: {
  env?: FCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const origin = options?.overrideOrigin?.trim() || options?.envBaseOrigin?.trim();
  return origin ? normalizeFCodeEndpointOrigin(origin) : DEFAULT_FCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeFCodeEnv(
  env: RuntimeFCodeEndpointEnv = readProductEndpointEnv(),
): FCodeEnv {
  // 产品身份仅用于既有展示与安装标识，不参与地址解析。
  return env.FCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeFCodeEndpointOrigin(
  env: RuntimeFCodeEndpointEnv = readProductEndpointEnv(),
  options?: { overrideOrigin?: string | null },
): string {
  return resolveFCodeEndpointOrigin({
    envBaseOrigin:
      readRuntimeEnvValue(env, "FCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "FCODE_ENDPOINT_ORIGIN"),
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeFCodeEndpointUrls(
  env: RuntimeFCodeEndpointEnv = readProductEndpointEnv(),
): FCodeEndpointUrls {
  return buildFCodeEndpointUrls(resolveRuntimeFCodeEndpointOrigin(env));
}

export function buildRuntimeFCodeApiUrl(
  env: RuntimeFCodeEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeFCodeEndpointOrigin(env)}${normalizedPath}`;
}

export function resolveBigModelApiOrigin(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return normalizeFCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? DEFAULT_BIGMODEL_API_ORIGIN,
  );
}

export function buildBigModelApiUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  // 管理页与业务 API 共用显式 origin，避免把已登录账号带到另一个部署。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeFCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? DEFAULT_ZAI_OAUTH_ORIGIN,
  );
}

export function resolveZaiBusinessBaseUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeFCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? DEFAULT_ZAI_BUSINESS_BASE_URL,
  );
}

export function resolveZaiOAuthClientId(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    DEFAULT_ZAI_OAUTH_CLIENT_ID
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeFCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = readProductEndpointEnv(),
): RuntimeProductEndpointConfig {
  const fcodeEnv = resolveRuntimeFCodeEnv(env);
  const fcodeEndpointOrigin = resolveRuntimeFCodeEndpointOrigin(env);

  return {
    fcodeEnv,
    fcodeEndpointOrigin,
    fcodeEndpointUrls: buildFCodeEndpointUrls(fcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildFCodeEndpointUrls(origin: string): FCodeEndpointUrls {
  const normalizedOrigin = normalizeFCodeEndpointOrigin(origin);
  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    fcodePlanOpenAiBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan`,
    fcodePlanAnthropicBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan/anthropic`,
    fcodePlanBillingCurrentUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/current`,
    fcodePlanBillingBalanceUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/balance`,
  };
}

export function rewriteFCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  const sourceOrigin = DEFAULT_FCODE_ENDPOINT_ORIGIN;
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeFCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
