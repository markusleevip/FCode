import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "@fcode/shared/node";
import { PROVIDER_OAUTH_ACCOUNT_CREDENTIAL_KEY as CREDENTIAL_KEY } from "@fcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import { getProviderOAuthModelCatalogSource } from "./modelCatalog.js";
import {
  PROVIDER_OAUTH_SUPPLIERS,
  type ProviderAccountSupplier,
  type ProviderOAuthAccountView,
} from "./contract.js";
import {
  ProviderOAuthError,
  type ProviderOAuthAccount,
  type ProviderOAuthTokens,
} from "./types.js";

const optionalText = z.string().min(1).optional();
const tokenSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: optionalText,
    expiresAt: z.number().finite().positive().optional(),
    idToken: optionalText,
    tokenEndpoint: optionalText,
    deviceId: optionalText,
    dcaToken: optionalText,
    apiBaseUrl: optionalText,
    accountIdentity: optionalText,
    email: optionalText,
    organizationId: optionalText,
    projectId: optionalText,
    clientEmail: optionalText,
    privateKey: optionalText,
    location: optionalText,
  })
  .strict();
const supplierSchema = z.enum([...PROVIDER_OAUTH_SUPPLIERS.map((item) => item.id), "vertex"]);
const accountSchema = z
  .object({
    accountId: z.string().min(1),
    revision: z.number().int().positive(),
    supplier: supplierSchema,
    displayName: z.string().min(1),
    enabled: z.boolean(),
    needsAuthorization: z.boolean(),
    tokens: tokenSchema,
    providerId: optionalText,
  })
  .strict();
const storeSchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema) }).strict();
type AccountStore = z.infer<typeof storeSchema>;
/** Private Host-only validation; parser diagnostics must never expose the account body. */
export function parseProviderOAuthAccountStore(raw: string): AccountStore {
  try {
    const store = storeSchema.parse(JSON.parse(raw));
    if (new Set(store.accounts.map((account) => account.accountId)).size !== store.accounts.length)
      throw new Error();
    return store;
  } catch {
    throw new ProviderOAuthError("corrupt_account_store");
  }
}

export function validateProviderOAuthProvisioningStore(raw: string): void {
  if (
    Buffer.byteLength(raw, "utf8") > 1_048_576 ||
    parseProviderOAuthAccountStore(raw).accounts.length > 256
  )
    throw new ProviderOAuthError("invalid_provisioning_account_store");
}
type RenewTokens = (
  account: ProviderOAuthAccount,
  refreshRequired: boolean,
) => Promise<ProviderOAuthTokens>;

/** Host 私有账号存储。所有读写走同一跨进程事务，不注册为 RPC 服务。 */
export class ProviderOAuthAccountRepository {
  private readonly lockPath: string;
  private readonly now: () => number;

  constructor(
    private readonly credentials: ICredentialService,
    options: { lockPath?: string; now?: () => number } = {},
  ) {
    // 独立于 credentials.json 的内部锁，避免嵌套获取同一把锁。
    this.lockPath = options.lockPath ?? join(getAppConfigDir(), "provider-oauth-accounts");
    this.now = options.now ?? Date.now;
  }

  async getAccounts(): Promise<ProviderOAuthAccountView[]> {
    return this.transaction(async (store) => store.accounts.map(accountView));
  }

  /** Host private coordinator, never registered on the account RPC projection. */
  withProvisioningLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, operation, { lockMaxWaitMs: 65_000 });
  }

  async getAccount(accountId: string): Promise<ProviderOAuthAccount> {
    return this.transaction(async (store) => structuredClone(this.find(store, accountId)));
  }

  async saveAuthorization(input: {
    supplier: ProviderAccountSupplier;
    tokens: ProviderOAuthTokens;
    displayName: string;
    target?: { accountId: string; revision: number };
    onBeforeCommit?: () => void;
  }): Promise<ProviderOAuthAccountView> {
    return this.transaction(async (store) => {
      const tokens = tokenSchema.parse(input.tokens);
      let account: ProviderOAuthAccount | undefined;
      if (input.target) {
        account = this.find(store, input.target.accountId);
        if (account.revision !== input.target.revision)
          throw new ProviderOAuthError("stale_authorization");
        if (account.supplier !== input.supplier || identitiesConflict(account.tokens, tokens)) {
          throw new ProviderOAuthError("account_identity_mismatch");
        }
      } else {
        const accountId = accountIdentity(input.supplier, tokens);
        account = store.accounts.find((item) => item.accountId === accountId);
        if (!account) {
          account = {
            accountId,
            revision: 1,
            supplier: input.supplier,
            displayName: input.displayName,
            tokens,
            enabled: true,
            needsAuthorization: false,
          };
          store.accounts.push(account);
        }
      }
      input.onBeforeCommit?.();
      account.tokens = tokens;
      account.displayName = input.displayName;
      account.needsAuthorization = false;
      account.revision += 1;
      await this.write(store);
      return accountView(account);
    });
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.transaction(async (store) => {
      const account = this.find(store, accountId);
      account.enabled = enabled;
      account.revision += 1;
      await this.write(store);
    });
  }

  async bindProvider(accountId: string, providerId: string): Promise<void> {
    await this.transaction(async (store) => {
      const account = this.find(store, accountId);
      account.providerId = providerId;
      account.revision += 1;
      await this.write(store);
    });
  }

  async connectProvider(
    accountId: string,
    connect: (account: ProviderOAuthAccount) => Promise<{
      providerId: string;
      rollback?: () => Promise<void>;
    }>,
  ): Promise<string> {
    return this.transaction(async (store) => {
      const account = this.find(store, accountId);
      if (!account.enabled) throw new ProviderOAuthError("account_disabled");
      if (account.needsAuthorization) throw new ProviderOAuthError("reauthorization_required");
      // 创建与保存绑定共用账号锁，防止两个窗口重复创建或移除后迟到写入。
      const connected = await connect(structuredClone(account));
      if (account.providerId === connected.providerId) return connected.providerId;
      account.providerId = connected.providerId;
      account.revision += 1;
      try {
        await this.write(store);
      } catch (error) {
        await connected.rollback?.();
        throw error;
      }
      return connected.providerId;
    });
  }

  async remove(accountId: string): Promise<void> {
    await this.transaction(async (store) => {
      store.accounts = store.accounts.filter((item) => item.accountId !== accountId);
      await this.write(store);
    });
  }

  async resolve(
    accountId: string,
    renew: RenewTokens,
    force = false,
    needsPreparation?: (account: ProviderOAuthAccount) => boolean,
  ): Promise<ProviderOAuthAccount> {
    // 锁覆盖网络刷新及持久化，另一个 Host 必须先重读轮换后的 refresh token。
    const result = await this.transaction(
      async (store): Promise<{ account?: ProviderOAuthAccount; error?: ProviderOAuthError }> => {
        const account = this.find(store, accountId);
        if (!account.enabled) throw new ProviderOAuthError("account_disabled");
        if (account.needsAuthorization) throw new ProviderOAuthError("reauthorization_required");
        const expired =
          account.tokens.expiresAt !== undefined && account.tokens.expiresAt <= this.now() + 60_000;
        if (!force && !expired && !needsPreparation?.(account))
          return { account: structuredClone(account) };
        try {
          // 准备项目与令牌轮换共用一次提交；未过期的旧账号不应为补项目重复消费 refresh token。
          const renewed = tokenSchema.parse(
            await renew(structuredClone(account), force || expired),
          );
          if (identitiesConflict(account.tokens, renewed))
            throw new ProviderOAuthError("account_identity_mismatch");
          account.tokens = renewed;
          account.revision += 1;
          await this.write(store);
          return { account: structuredClone(account) };
        } catch (error) {
          if (
            error instanceof ProviderOAuthError &&
            (error.code === "invalid_grant" || error.code === "reauthorization_required")
          ) {
            account.needsAuthorization = true;
            account.revision += 1;
            await this.write(store);
            return { error };
          }
          throw error;
        }
      },
    );
    if (result.error) throw result.error;
    if (!result.account) throw new ProviderOAuthError("account_not_found");
    return result.account;
  }

  private find(store: AccountStore, accountId: string): ProviderOAuthAccount {
    const account = store.accounts.find((item) => item.accountId === accountId);
    if (!account) throw new ProviderOAuthError("account_not_found");
    return account;
  }

  private async transaction<T>(operation: (store: AccountStore) => Promise<T>): Promise<T> {
    return this.withProvisioningLock(async () => {
      const raw = await this.credentials.load(CREDENTIAL_KEY);
      if (raw === null) return operation({ version: 1, accounts: [] });
      return operation(parseProviderOAuthAccountStore(raw));
    });
  }

  private async write(store: AccountStore): Promise<void> {
    await this.credentials.save(CREDENTIAL_KEY, JSON.stringify(storeSchema.parse(store)));
  }
}

function accountIdentity(supplier: ProviderAccountSupplier, tokens: ProviderOAuthTokens): string {
  const identity = tokens.accountIdentity ?? tokens.email ?? tokens.clientEmail;
  if (!identity) return randomUUID();
  return createHash("sha256")
    .update(
      JSON.stringify([supplier, identity, tokens.organizationId ?? "", tokens.projectId ?? ""]),
    )
    .digest("hex");
}

function identitiesConflict(previous: ProviderOAuthTokens, next: ProviderOAuthTokens): boolean {
  return (["accountIdentity", "organizationId", "projectId", "clientEmail"] as const).some(
    (key) => previous[key] !== undefined && next[key] !== undefined && previous[key] !== next[key],
  );
}

function accountView(account: ProviderOAuthAccount): ProviderOAuthAccountView {
  return {
    accountId: account.accountId,
    supplier: account.supplier,
    displayName: account.displayName,
    email: account.tokens.email,
    enabled: account.enabled,
    needsAuthorization: account.needsAuthorization,
    expiresAt: account.tokens.expiresAt,
    providerId: account.providerId,
    modelCatalogSource: getProviderOAuthModelCatalogSource(account.supplier),
  };
}
