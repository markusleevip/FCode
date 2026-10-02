import type { ProviderConfigObject } from "@fcode/provider";
import { getNativeProviderPresentation } from "@fcode/provider";
import { ANTIGRAVITY_NATIVE_INFERENCE_ORIGIN } from "@fcode/shared";
import { metaApiBaseUrl } from "./metaCredentials.js";
import { CLINE_API_BASE_URL } from "./clineCredentials.js";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import type { ProviderOAuthAccountRepository } from "./accountRepository.js";
import {
  PROVIDER_OAUTH_LOGIN_SUPPLIERS,
  type IProviderOAuthService,
  type ProviderOAuthModel,
  type ProviderOAuthUsageView,
} from "./contract.js";
import type { ProviderOAuthFlowController } from "./flowController.js";
import { ProviderOAuthImporter } from "./importer.js";
import type { NativeProviderOAuthProtocol } from "./protocol.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";

interface ProviderOAuthRuntimeOptions {
  accounts: ProviderOAuthAccountRepository;
  protocol: NativeProviderOAuthProtocol;
  flows: ProviderOAuthFlowController;
  providers: IProviderSettingsService;
  importer?: ProviderOAuthImporter;
  getModels: (
    account: ProviderOAuthAccount,
    signal: AbortSignal,
  ) => Promise<readonly ProviderOAuthModel[]>;
  getUsage?: (
    account: ProviderOAuthAccount,
    signal: AbortSignal,
  ) => Promise<Omit<ProviderOAuthUsageView, "accountId" | "fetchedAt">>;
  redeemUsageReset?: (
    account: ProviderOAuthAccount,
    creditId: string | undefined,
    signal: AbortSignal,
  ) => Promise<"reset" | "nothing_to_reset">;
}

// 额度是厂商内部接口，设置页反复打开/刷新时不应逐次打到上游。
const USAGE_CACHE_MS = 30_000;

/** 私有 Host runtime 与安全 RPC 投影分开，避免 ProxyChannel 暴露令牌解析方法。 */
export class ProviderOAuthRuntime {
  readonly service: IProviderOAuthService;
  private readonly abort = new AbortController();
  private readonly importer: ProviderOAuthImporter;
  private readonly usageCache = new Map<string, { key: string; view: ProviderOAuthUsageView }>();
  // One redeem per account at a time: a double click must never spend two credits.
  private readonly redeemsInFlight = new Set<string>();
  constructor(private readonly options: ProviderOAuthRuntimeOptions) {
    this.importer = options.importer ?? new ProviderOAuthImporter();
    const check = () => this.checkActive();
    // ProxyChannel 按属性取方法；普通对象的 constructor/valueOf 会越过契约。
    // 注册投影清除原型并冻结，只暴露下方明确的安全方法，不改全局 RPC 类实例规则。
    this.service = Object.freeze(
      Object.setPrototypeOf(
        {
          getSuppliers: async () => {
            check();
            return PROVIDER_OAUTH_LOGIN_SUPPLIERS;
          },
          getAccounts: async () => {
            check();
            return options.accounts.getAccounts();
          },
          startLogin: async (input) => {
            check();
            return options.flows.startLogin(input);
          },
          getLogin: async (state) => {
            check();
            return options.flows.getLogin(state);
          },
          submitCallback: async (state, url) => {
            check();
            return options.flows.submitCallback(state, url);
          },
          cancelLogin: async (state) => {
            check();
            return options.flows.cancelLogin(state);
          },
          setAccountEnabled: async (accountId, enabled) => {
            check();
            await options.accounts.setEnabled(accountId, enabled);
          },
          removeAccount: async (accountId) => {
            check();
            await options.accounts.remove(accountId);
          },
          refreshAccount: async (accountId) => {
            await this.resolveAccount(accountId, true);
            const view = (await options.accounts.getAccounts()).find(
              (item) => item.accountId === accountId,
            );
            if (!view) throw new ProviderOAuthError("account_not_found");
            return view;
          },
          getModels: async (accountId) => {
            const account = await this.resolveAccount(accountId);
            const models = await options.getModels(account, this.abort.signal);
            check();
            // 目录请求会跨越账号操作；用原账号 owner 复核，拒绝旧授权/停用后的迟到结果。
            const current = await options.accounts.getAccount(accountId);
            check();
            if (!current.enabled) throw new ProviderOAuthError("account_disabled");
            if (current.needsAuthorization)
              throw new ProviderOAuthError("reauthorization_required");
            if (current.supplier !== account.supplier || current.revision !== account.revision)
              throw new ProviderOAuthError("stale_model_catalog");
            return models;
          },
          getUsage: async (accountId) => {
            const account = await this.resolveAccount(accountId);
            if (
              !options.getUsage ||
              (account.supplier !== "codex" &&
                account.supplier !== "antigravity" &&
                account.supplier !== "cline")
            )
              throw new ProviderOAuthError("unsupported_usage");
            const key = `${account.revision}:${account.supplier}`;
            const cached = this.usageCache.get(accountId);
            if (cached?.key === key && Date.now() - cached.view.fetchedAt < USAGE_CACHE_MS)
              return cached.view;
            const usage = await options.getUsage(account, this.abort.signal);
            check();
            // 与 getModels 相同：请求跨越账号操作，用原账号 owner 复核后才返回。
            const current = await options.accounts.getAccount(accountId);
            check();
            if (!current.enabled) throw new ProviderOAuthError("account_disabled");
            if (current.needsAuthorization)
              throw new ProviderOAuthError("reauthorization_required");
            if (current.supplier !== account.supplier || current.revision !== account.revision)
              throw new ProviderOAuthError("stale_usage");
            const view: ProviderOAuthUsageView = { ...usage, accountId, fetchedAt: Date.now() };
            this.usageCache.set(accountId, { key, view });
            return view;
          },
          redeemUsageReset: async (accountId, creditId) => {
            const account = await this.resolveAccount(accountId);
            if (!options.redeemUsageReset || account.supplier !== "codex")
              throw new ProviderOAuthError("unsupported_usage");
            if (!account.enabled) throw new ProviderOAuthError("account_disabled");
            if (account.needsAuthorization)
              throw new ProviderOAuthError("reauthorization_required");
            if (this.redeemsInFlight.has(accountId))
              throw new ProviderOAuthError("reset_in_progress");
            this.redeemsInFlight.add(accountId);
            try {
              const outcome = await options.redeemUsageReset(account, creditId, this.abort.signal);
              return { outcome };
            } finally {
              // The cached windows and credit count are stale after any attempt, successful or not.
              this.usageCache.delete(accountId);
              this.redeemsInFlight.delete(accountId);
            }
          },
          connectAccount: async (accountId) => {
            check();
            return options.accounts.connectProvider(accountId, async (account) => {
              const view = await options.providers.getView();
              check();
              const matching = view.providers.find(
                (item) =>
                  item.effectiveConfig.access?.type === "provider-oauth" &&
                  item.effectiveConfig.access.accountId === account.accountId &&
                  item.effectiveConfig.access.supplier === account.supplier,
              );
              if (matching) return { providerId: matching.providerId };
              const config = accountProviderConfig(account);
              const created = await options.providers.createPersonalProvider({
                providerName:
                  getNativeProviderPresentation(config.access)?.providerName ?? account.displayName,
                initialConfig: config,
              });
              if (this.abort.signal.aborted) {
                await options.providers.deletePersonalProvider(created.providerId);
                check();
              }
              return {
                providerId: created.providerId,
                rollback: async () => {
                  await options.providers.deletePersonalProvider(created.providerId);
                },
              };
            });
          },
          importAccount: async (input) => {
            check();
            const imported = await this.importer.parse(input, this.abort.signal);
            return options.accounts.saveAuthorization({ ...imported, onBeforeCommit: check });
          },
        } satisfies IProviderOAuthService,
        null,
      ),
    );
  }

  async resolveAccount(accountId: string, force = false): Promise<ProviderOAuthAccount> {
    this.checkActive();
    const account = await this.options.accounts.resolve(
      accountId,
      async (current, refreshRequired) => {
        this.checkActive();
        let tokens = !refreshRequired
          ? current.tokens
          : current.supplier === "vertex"
            ? await this.importer.refreshVertex(current.tokens, this.abort.signal)
            : await this.options.protocol.refresh(
                current.supplier,
                current.tokens,
                this.abort.signal,
              );
        if (current.supplier === "antigravity")
          tokens = await this.options.protocol.prepare(current.supplier, tokens, this.abort.signal);
        this.checkActive();
        return tokens;
      },
      force,
      (current) => current.supplier === "antigravity" && !current.tokens.projectId,
    );
    this.checkActive();
    return account;
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    await this.options.flows.dispose();
  }

  private checkActive(): void {
    if (this.abort.signal.aborted) throw new ProviderOAuthError("host_disposed");
  }
}

function accountProviderConfig(account: ProviderOAuthAccount): ProviderConfigObject {
  const api: NonNullable<ProviderConfigObject["api"]> = (() => {
    switch (account.supplier) {
      case "codex":
        return { type: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
      case "claude":
        return { type: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" };
      case "kimi":
        return { type: "anthropic-messages", baseUrl: "https://api.kimi.com/coding/v1" };
      case "kimi-ai":
        return { type: "anthropic-messages", baseUrl: "https://api.kimi.ai/coding/v1" };
      case "xai":
        return { type: "openai-responses", baseUrl: "https://cli-chat-proxy.grok.com/v1" };
      case "meta":
        return { type: "openai-responses", baseUrl: metaApiBaseUrl(account.tokens.apiBaseUrl) };
      case "cline":
        return { type: "openai-chat-completions", baseUrl: CLINE_API_BASE_URL };
      case "antigravity":
        return {
          type: "anthropic-messages",
          baseUrl: `${ANTIGRAVITY_NATIVE_INFERENCE_ORIGIN}/v1internal`,
        };
      case "devin":
        return { type: "anthropic-messages", baseUrl: "https://server.codeium.com" };
      case "vertex":
        return {
          type: "anthropic-messages",
          baseUrl:
            !account.tokens.location || account.tokens.location === "global"
              ? "https://aiplatform.googleapis.com/v1"
              : `https://${account.tokens.location}-aiplatform.googleapis.com/v1`,
        };
    }
  })();
  const access = {
    type: "provider-oauth",
    supplier: account.supplier,
    accountId: account.accountId,
  } as const;
  const presentation = getNativeProviderPresentation(access);
  return {
    access,
    ...(presentation ? { logo: presentation.logo } : {}),
    api,
  };
}
