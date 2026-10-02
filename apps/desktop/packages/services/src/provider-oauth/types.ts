import type { ProviderAccountSupplier, ProviderOAuthSupplier } from "./contract.js";

/** Host 私有凭据，禁止通过 RPC 暴露。 */
export interface ProviderOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
  tokenEndpoint?: string;
  deviceId?: string;
  dcaToken?: string;
  apiBaseUrl?: string;
  accountIdentity?: string;
  email?: string;
  organizationId?: string;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  location?: string;
}

export interface ProviderOAuthAccount {
  accountId: string;
  revision: number;
  supplier: ProviderAccountSupplier;
  displayName: string;
  enabled: boolean;
  needsAuthorization: boolean;
  tokens: ProviderOAuthTokens;
  providerId?: string;
}

export interface ProviderOAuthAttempt {
  supplier: ProviderOAuthSupplier;
  state: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
  deviceId: string;
  /** 用户明确选择的项目；仅 Antigravity 初始/重新授权使用。 */
  projectId?: string;
}

export interface ProviderDeviceAuthorization {
  authorizeUrl: string;
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  tokenEndpoint: string;
}

export class ProviderOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    // 厂商错误正文可能包含 token、authorization code 和账号资料，只暴露受控错误码。
    super(`Provider authorization failed (${code}${status ? `, HTTP ${status}` : ""})`);
    this.name = "ProviderOAuthError";
  }
}
