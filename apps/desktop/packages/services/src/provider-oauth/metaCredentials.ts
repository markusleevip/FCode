// Meta DCA → API key exchange adapted from CLIProxyAPI (MIT).
import { ProviderOAuthTransport, requiredString, string } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthTokens } from "./types.js";

const META_KEY_ENDPOINT = "https://api.meta.ai/muse-code/key";
export const META_DEFAULT_API_BASE = "https://api.meta.ai/v1";

/** Credentials may select an official version, never a host to receive the API key. */
export function metaApiBaseUrl(value: unknown): string {
  if (value === undefined) return META_DEFAULT_API_BASE;
  try {
    const url = new URL(requiredString(value));
    if (
      url.protocol === "https:" &&
      url.hostname === "api.meta.ai" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/v[1-9][0-9]*\/?$/.test(url.pathname)
    ) {
      return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
    }
  } catch {
    /* 不把厂商或导入文件中的地址带入错误正文。 */
  }
  throw new ProviderOAuthError("invalid_endpoint");
}

export async function mintMetaCredentials(
  transport: ProviderOAuthTransport,
  previous: ProviderOAuthTokens,
  signal: AbortSignal,
): Promise<ProviderOAuthTokens> {
  if (!previous.dcaToken) throw new ProviderOAuthError("reauthorization_required");
  const minted = await transport.json(META_KEY_ENDPOINT, { dca_token: previous.dcaToken }, signal, {
    authorization: `Bearer ${previous.dcaToken}`,
    "user-agent": "muse-code/1.0.2",
  });
  // DCA 的有效期属于换 key 材料，不能拿它判定长期 API key 已过期。
  return {
    ...previous,
    accessToken: requiredString(minted.api_key),
    expiresAt: undefined,
    apiBaseUrl: metaApiBaseUrl(minted.base_url ?? previous.apiBaseUrl),
    email: string(minted.user_email) ?? previous.email,
    accountIdentity: string(minted.user_email) ?? previous.accountIdentity,
  };
}
