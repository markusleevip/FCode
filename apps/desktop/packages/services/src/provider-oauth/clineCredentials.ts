// Cline account exchange and refresh. Request and response shapes of /auth/register and
// /auth/refresh match the public Cline SDK (Apache-2.0); this implementation is original.
import { object, requiredString, string, ProviderOAuthTransport } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthTokens } from "./types.js";

export const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1";
const CLINE_TOKEN_PREFIX = "workos:";

/** Cline expects the WorkOS JWT with a `workos:` scheme prefix; a bare JWT is rejected with 401. */
export function formatClineApiToken(accessToken: string): string {
  const token = accessToken.trim();
  return token.toLowerCase().startsWith(CLINE_TOKEN_PREFIX)
    ? token
    : `${CLINE_TOKEN_PREFIX}${token}`;
}

function stripClineTokenPrefix(accessToken: string): string {
  const token = accessToken.trim();
  return token.toLowerCase().startsWith(CLINE_TOKEN_PREFIX)
    ? token.slice(CLINE_TOKEN_PREFIX.length)
    : token;
}

function parseClineTokens(
  payload: Record<string, unknown>,
  previous?: ProviderOAuthTokens,
): ProviderOAuthTokens {
  const data = object(payload.data);
  if (payload.success !== true) throw new ProviderOAuthError("invalid_response");
  const userInfo = object(data.userInfo);
  const expiresAt = Date.parse(requiredString(data.expiresAt));
  if (Number.isNaN(expiresAt)) throw new ProviderOAuthError("invalid_response");
  const refreshToken = string(data.refreshToken) ?? previous?.refreshToken;
  if (!refreshToken) throw new ProviderOAuthError("invalid_response");
  const email = string(userInfo.email) ?? previous?.email;
  return {
    ...previous,
    accessToken: stripClineTokenPrefix(requiredString(data.accessToken)),
    refreshToken,
    expiresAt,
    accountIdentity: string(userInfo.clineUserId) ?? previous?.accountIdentity ?? email,
    email,
  };
}

/** Exchange the WorkOS device-flow tokens for Cline account credentials. */
export async function registerClineCredentials(
  transport: ProviderOAuthTransport,
  workos: { accessToken: string; refreshToken: string },
  signal: AbortSignal,
): Promise<ProviderOAuthTokens> {
  const payload = await transport.json(
    `${CLINE_API_BASE_URL}/auth/register`,
    { accessToken: workos.accessToken, refreshToken: workos.refreshToken },
    signal,
  );
  return parseClineTokens(payload);
}

export async function refreshClineCredentials(
  transport: ProviderOAuthTransport,
  previous: ProviderOAuthTokens,
  signal: AbortSignal,
): Promise<ProviderOAuthTokens> {
  const refreshToken = requiredString(previous.refreshToken);
  try {
    const payload = await transport.json(
      `${CLINE_API_BASE_URL}/auth/refresh`,
      { refreshToken, grantType: "refresh_token" },
      signal,
    );
    return parseClineTokens(payload, previous);
  } catch (error) {
    // Only a rejected refresh token means the user must sign in again; transient failures keep the account usable.
    if (
      error instanceof ProviderOAuthError &&
      (error.status === 400 || error.status === 401 || error.status === 403)
    ) {
      throw new ProviderOAuthError("invalid_grant", error.status);
    }
    throw error;
  }
}
