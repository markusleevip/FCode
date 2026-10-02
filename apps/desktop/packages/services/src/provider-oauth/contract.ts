import { createServiceDescriptor } from "../descriptors.js";

export const PROVIDER_OAUTH_SUPPLIERS = [
  { id: "codex", name: "Codex", flow: "browser" },
  { id: "claude", name: "Anthropic / Claude", flow: "browser" },
  { id: "antigravity", name: "Antigravity", flow: "browser" },
  { id: "kimi", name: "Kimi", flow: "device" },
  { id: "kimi-ai", name: "Kimi.ai", flow: "device" },
  { id: "xai", name: "xAI / Grok", flow: "device" },
  { id: "devin", name: "Devin", flow: "browser" },
  { id: "meta", name: "Meta", flow: "device" },
  { id: "cline", name: "Cline", flow: "device" },
] as const;

/**
 * Suppliers whose sign-in is retired: they are neither listed nor accepted by startLogin, but the
 * type and stored accounts stay valid so existing data keeps loading.
 */
export const PROVIDER_OAUTH_RETIRED_SUPPLIERS: readonly string[] = ["devin"];

export const PROVIDER_OAUTH_LOGIN_SUPPLIERS = PROVIDER_OAUTH_SUPPLIERS.filter(
  (supplier) => !PROVIDER_OAUTH_RETIRED_SUPPLIERS.includes(supplier.id),
);

/**
 * Codex 目录里出现、但不是 Responses API `reasoning.effort` 取值的档位。
 * ultra 是 Codex 客户端用子智能体并行拆分任务的模式，persistent 同属客户端模式；
 * API 只接受 none/minimal/low/medium/high/xhigh/max，原样发送会得到 HTTP 400。
 */
export const CODEX_CLIENT_ONLY_REASONING_LEVELS: readonly string[] = ["ultra", "persistent"];

export type ProviderOAuthSupplier = (typeof PROVIDER_OAUTH_SUPPLIERS)[number]["id"];
export type ProviderAccountSupplier = ProviderOAuthSupplier | "vertex";

export interface ProviderOAuthAccountView {
  readonly accountId: string;
  readonly supplier: ProviderAccountSupplier;
  readonly displayName: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly needsAuthorization: boolean;
  readonly expiresAt?: number;
  readonly providerId?: string;
  /** 查询能力来源；旧 Host 可不提供，不代表实际推理权限已经验证。 */
  readonly modelCatalogSource?: ProviderOAuthModel["source"];
}

export interface ProviderOAuthFlowView {
  readonly state: string;
  readonly supplier: ProviderOAuthSupplier;
  readonly status: "awaiting" | "exchanging" | "connected" | "failed" | "cancelled" | "expired";
  readonly authorizeUrl?: string;
  readonly userCode?: string;
  readonly expiresAt: number;
  readonly accountId?: string;
  readonly error?: string;
  /** 重新授权的目标由 Host 确认；失败后的重试不能丢失目标账号。 */
  readonly targetAccountId?: string;
}

export interface ProviderOAuthModel {
  readonly id: string;
  readonly name: string;
  readonly source: "preset" | "account";
  /** 账号目录声明的实际档位；缺失保持旧目录兼容，不由 UI 猜测。 */
  readonly reasoningLevels?: readonly string[];
  /** 账号目录声明的输入模态含 image；缺失表示目录未声明，不覆盖内置规则。 */
  readonly supportsImage?: boolean;
}

/** 一个额度窗口：Codex 的 5 小时/每周窗口，或 Antigravity 的单个模型额度。 */
export interface ProviderOAuthUsageWindow {
  readonly id: string;
  /** 模型显示名；窗口型额度没有名称，由 UI 按 windowSeconds 生成。 */
  readonly label?: string;
  readonly windowSeconds?: number;
  /** 0–100，已使用比例。 */
  readonly usedPercent: number;
  /** 毫秒时间戳。 */
  readonly resetsAt?: number;
}

/** One banked "full reset" credit; redeeming it zeroes every usage window of the account. */
export interface ProviderOAuthResetCredit {
  readonly id: string;
  /** Millisecond timestamp; absent when the credit does not expire. */
  readonly expiresAt?: number;
}

export interface ProviderOAuthUsageView {
  readonly accountId: string;
  readonly plan?: string;
  /** Usable reset credits, earliest expiry first; absent when the provider has no such concept or the lookup failed. */
  readonly resetCredits?: readonly ProviderOAuthResetCredit[];
  /** Subscription renewal time in milliseconds, when the account credentials carry it. */
  readonly renewsAt?: number;
  readonly windows: readonly ProviderOAuthUsageWindow[];
  readonly fetchedAt: number;
}

/** Renderer 安全的供应商账号管理面；请求期凭据解析不在 RPC 面上。 */
export interface IProviderOAuthService {
  getSuppliers(): Promise<readonly (typeof PROVIDER_OAUTH_SUPPLIERS)[number][]>;
  getAccounts(): Promise<readonly ProviderOAuthAccountView[]>;
  startLogin(input: {
    supplier: ProviderOAuthSupplier;
    accountId?: string;
    projectId?: string;
  }): Promise<ProviderOAuthFlowView>;
  getLogin(state: string): Promise<ProviderOAuthFlowView>;
  submitCallback(state: string, callbackUrl: string): Promise<ProviderOAuthFlowView>;
  cancelLogin(state: string): Promise<ProviderOAuthFlowView>;
  setAccountEnabled(accountId: string, enabled: boolean): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  refreshAccount(accountId: string): Promise<ProviderOAuthAccountView>;
  getModels(accountId: string): Promise<readonly ProviderOAuthModel[]>;
  /** Supported for Codex, Antigravity and Cline; other suppliers fail with unsupported_usage. */
  getUsage(accountId: string): Promise<ProviderOAuthUsageView>;
  /**
   * Codex only. Spends one reset credit (the earliest expiring unless creditId is given) and clears
   * the usage windows. Irreversible and never retried automatically.
   */
  redeemUsageReset(
    accountId: string,
    creditId?: string,
  ): Promise<{ readonly outcome: "reset" | "nothing_to_reset" }>;
  connectAccount(accountId: string): Promise<string>;
  importAccount(input: { json: string; location?: string }): Promise<ProviderOAuthAccountView>;
}

export const IProviderOAuthService =
  createServiceDescriptor<IProviderOAuthService>("provider-oauth");
