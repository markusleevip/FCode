import {
  getProviderOAuthConnectionKey,
  type ProviderConfigMap,
  type AccountProviderStates,
  type AccountProviderUnavailableReason,
} from "@fcode/provider";
import type { ProviderOAuthAccountView } from "./contract.js";

/** 只读取安全视图，不刷新令牌、不查询模型；repository 是账号状态的唯一事实源。 */
export async function resolveProviderOAuthAccountStates(
  configured: ProviderConfigMap,
  readAccounts?: () => Promise<readonly ProviderOAuthAccountView[]>,
): Promise<AccountProviderStates> {
  const native = configured
    .entries()
    .filter(([, config]) => config.access?.type === "provider-oauth");
  if (!native.length) return {};
  let accounts: readonly ProviderOAuthAccountView[] = [];
  let readFailed = false;
  try {
    if (readAccounts) accounts = await readAccounts();
  } catch {
    // 读取损坏不能保留上次的绿色可用状态；请求期仍由原 owner 再次鉴权。
    readFailed = true;
  }
  return Object.fromEntries(
    native.map(([providerId, config]) => {
      const access = config.access!;
      if (access.type !== "provider-oauth") throw new Error("Invalid native account projection");
      const account = accounts.find((item) => item.accountId === access.accountId);
      const reason: AccountProviderUnavailableReason | undefined = readFailed
        ? "credential-failed"
        : !account || !account.enabled
          ? "not-connected"
          : account.supplier !== access.supplier
            ? "credential-failed"
            : account.needsAuthorization
              ? "not-authenticated"
              : undefined;
      return [
        providerId,
        Object.freeze({
          availability: reason ? "unavailable" : "available",
          entitled: reason === undefined,
          connectionKey: getProviderOAuthConnectionKey(access),
          ...(reason ? { unavailableReason: reason } : {}),
        }),
      ];
    }),
  );
}
