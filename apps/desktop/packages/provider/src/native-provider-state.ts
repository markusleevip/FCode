import type { ProviderConfigObject } from "./config/index.js";

/** 原生账号状态只匹配当前引用，旧账号的可用性不能被改绑后的连接复用。 */
export function getProviderOAuthConnectionKey(
  access: Extract<NonNullable<ProviderConfigObject["access"]>, { type: "provider-oauth" }>,
): string {
  return JSON.stringify([access.supplier, access.accountId]);
}
