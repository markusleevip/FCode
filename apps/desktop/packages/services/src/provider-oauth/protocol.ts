// Native TypeScript port of CLIProxyAPI OAuth protocols (MIT); no proxy process is used.
import { hostname } from "node:os";
import { mintMetaCredentials } from "./metaCredentials.js";
import { refreshClineCredentials, registerClineCredentials } from "./clineCredentials.js";
import { prepareAntigravityProject } from "./antigravityProject.js";
import type { ProviderOAuthSupplier } from "./contract.js";
import {
  CLAUDE_SCOPE,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_SCOPE,
  OAUTH_CLIENTS,
  XAI_SCOPE,
} from "./protocolConfig.js";
import {
  object,
  positiveNumber,
  ProviderOAuthTransport,
  requiredString,
  string,
  httpsUrl,
  xaiEndpoint,
  type OAuthObject,
} from "./protocolTransport.js";
import {
  ProviderOAuthError,
  type ProviderDeviceAuthorization,
  type ProviderOAuthAttempt,
  type ProviderOAuthTokens,
} from "./types.js";

export class NativeProviderOAuthProtocol {
  private readonly transport: ProviderOAuthTransport;
  private readonly now: () => number;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.transport = new ProviderOAuthTransport(options.fetch ?? globalThis.fetch);
    this.now = options.now ?? Date.now;
  }

  authorizeUrl(attempt: ProviderOAuthAttempt): string {
    const { supplier, state, redirectUri, challenge } = attempt;
    const common = { state, redirect_uri: redirectUri, response_type: "code" };
    let url: URL;
    let params: Record<string, string>;
    switch (supplier) {
      case "codex":
        url = new URL("https://auth.openai.com/oauth/authorize");
        params = {
          ...common,
          client_id: OAUTH_CLIENTS.codex.clientId,
          scope: "openid email profile offline_access",
          prompt: "login",
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
        };
        break;
      case "claude":
        url = new URL("https://claude.ai/oauth/authorize");
        params = {
          ...common,
          client_id: OAUTH_CLIENTS.claude.clientId,
          code: "true",
          scope: CLAUDE_SCOPE,
        };
        break;
      case "antigravity":
        url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        params = {
          ...common,
          client_id: OAUTH_CLIENTS.antigravity.clientId,
          scope: GOOGLE_SCOPE,
          access_type: "offline",
          prompt: "consent",
        };
        break;
      case "devin":
        url = new URL("https://app.devin.ai/auth/cli/continue");
        params = { state, redirect_uri: redirectUri, prompt: "select_account" };
        break;
      default:
        throw new ProviderOAuthError("unsupported_flow");
    }
    if (supplier !== "antigravity") {
      params.code_challenge = challenge;
      params.code_challenge_method = "S256";
    }
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  async exchangeCode(
    attempt: ProviderOAuthAttempt,
    code: string,
    signal: AbortSignal,
  ): Promise<ProviderOAuthTokens> {
    const { supplier, redirectUri, verifier, state } = attempt;
    let payload: OAuthObject;
    switch (supplier) {
      case "claude": {
        const [bareCode, codeState] = code.split("#");
        if (codeState !== undefined && codeState !== state)
          throw new ProviderOAuthError("invalid_state");
        payload = await this.transport.json(
          OAUTH_CLIENTS.claude.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code: requiredString(bareCode),
            redirect_uri: redirectUri,
            client_id: OAUTH_CLIENTS.claude.clientId,
            code_verifier: verifier,
            state,
          },
          signal,
          { "user-agent": "axios/1.15.2" },
        );
        break;
      }
      case "codex":
        payload = await this.transport.form(
          OAUTH_CLIENTS.codex.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: OAUTH_CLIENTS.codex.clientId,
            code_verifier: verifier,
          },
          signal,
        );
        break;
      case "antigravity":
        payload = await this.transport.form(
          OAUTH_CLIENTS.antigravity.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: OAUTH_CLIENTS.antigravity.clientId,
            client_secret: GOOGLE_CLIENT_SECRET,
          },
          signal,
        );
        break;
      case "devin": {
        payload = await this.transport.json(
          OAUTH_CLIENTS.devin.tokenEndpoint,
          {
            code,
            code_verifier: verifier,
          },
          signal,
        );
        const raw = requiredString(payload.token);
        const token = raw.startsWith("eyJ") ? `devin-session-token$${raw}` : raw;
        const profile = await this.transport.request(
          "https://api.devin.ai/v3/self",
          {
            headers: { authorization: `Bearer ${token}` },
          },
          signal,
        );
        return {
          accessToken: token,
          // flow 已拥有设备身份；随凭据保存，让后续请求和重启复用同一指纹种子。
          deviceId: attempt.deviceId,
          accountIdentity: string(profile.user_id),
          organizationId: string(profile.org_id),
          email: string(profile.user_name),
        };
      }
      default:
        throw new ProviderOAuthError("unsupported_flow");
    }
    const tokens = this.tokens(payload);
    if (supplier === "antigravity") {
      const profile = await this.transport.request(
        "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
        {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        },
        signal,
      );
      tokens.accountIdentity = string(profile.id);
      tokens.email = string(profile.email);
      return this.prepare(supplier, tokens, signal, attempt.projectId);
    }
    return tokens;
  }

  prepare(
    supplier: ProviderOAuthSupplier,
    tokens: ProviderOAuthTokens,
    signal: AbortSignal,
    projectId?: string,
  ): Promise<ProviderOAuthTokens> {
    return supplier === "antigravity"
      ? prepareAntigravityProject(this.transport, tokens, signal, projectId)
      : Promise.resolve(tokens);
  }

  async startDevice(
    attempt: ProviderOAuthAttempt,
    signal: AbortSignal,
  ): Promise<ProviderDeviceAuthorization> {
    const { supplier } = attempt;
    if (
      supplier !== "kimi" &&
      supplier !== "kimi-ai" &&
      supplier !== "xai" &&
      supplier !== "meta" &&
      supplier !== "cline"
    ) {
      throw new ProviderOAuthError("unsupported_flow");
    }
    const config = OAUTH_CLIENTS[supplier];
    const endpoints = supplier === "xai" ? await this.discoverXai(signal) : OAUTH_CLIENTS[supplier];
    if (!("deviceEndpoint" in endpoints) || !("tokenEndpoint" in endpoints)) {
      throw new ProviderOAuthError("invalid_endpoint");
    }
    const payload = await this.transport.form(
      endpoints.deviceEndpoint,
      {
        client_id: config.clientId,
        ...(supplier === "xai" ? { scope: XAI_SCOPE } : {}),
      },
      signal,
      this.headers(supplier, attempt.deviceId),
    );
    return {
      authorizeUrl: httpsUrl(
        payload.verification_uri_complete ?? payload.verification_uri ?? payload.verification_url,
      ),
      deviceCode: requiredString(payload.device_code),
      userCode: requiredString(payload.user_code),
      expiresIn: Math.min(
        positiveNumber(payload.expires_in) ?? 900,
        supplier === "xai" ? 1800 : 900,
      ),
      interval: Math.max(positiveNumber(payload.interval) ?? 5, 5),
      tokenEndpoint: endpoints.tokenEndpoint,
    };
  }

  async pollDevice(
    attempt: ProviderOAuthAttempt,
    device: ProviderDeviceAuthorization,
    signal: AbortSignal,
  ): Promise<ProviderOAuthTokens> {
    const { supplier } = attempt;
    const config = OAUTH_CLIENTS[supplier];
    if (
      !("clientId" in config) ||
      (supplier !== "kimi" &&
        supplier !== "kimi-ai" &&
        supplier !== "xai" &&
        supplier !== "meta" &&
        supplier !== "cline")
    ) {
      throw new ProviderOAuthError("unsupported_flow");
    }
    const endpoint =
      supplier === "xai"
        ? xaiEndpoint(device.tokenEndpoint)
        : OAUTH_CLIENTS[supplier].tokenEndpoint;
    const payload = await this.transport.form(
      endpoint,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: device.deviceCode,
      },
      signal,
      this.headers(supplier, attempt.deviceId),
    );
    if (supplier === "cline") {
      return registerClineCredentials(
        this.transport,
        {
          accessToken: requiredString(payload.access_token),
          refreshToken: requiredString(payload.refresh_token),
        },
        signal,
      );
    }
    const tokens = this.tokens(payload);
    tokens.deviceId = attempt.deviceId;
    tokens.tokenEndpoint = endpoint;
    if (supplier === "meta") {
      return mintMetaCredentials(
        this.transport,
        { accessToken: tokens.accessToken, dcaToken: tokens.accessToken },
        signal,
      );
    }
    return tokens;
  }

  async refresh(
    supplier: ProviderOAuthSupplier,
    previous: ProviderOAuthTokens,
    signal: AbortSignal,
  ): Promise<ProviderOAuthTokens> {
    if (supplier === "meta") return mintMetaCredentials(this.transport, previous, signal);
    if (supplier === "cline") return refreshClineCredentials(this.transport, previous, signal);
    if (supplier === "devin") throw new ProviderOAuthError("reauthorization_required");
    const refreshToken = requiredString(previous.refreshToken);
    const config = OAUTH_CLIENTS[supplier];
    const endpoint =
      supplier === "xai"
        ? previous.tokenEndpoint
          ? xaiEndpoint(previous.tokenEndpoint)
          : (await this.discoverXai(signal)).tokenEndpoint
        : OAUTH_CLIENTS[supplier].tokenEndpoint;
    const data = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    };
    let payload: OAuthObject;
    if (supplier === "claude") {
      payload = await this.transport.json(endpoint, { ...data, scope: CLAUDE_SCOPE }, signal, {
        "user-agent": "axios/1.15.2",
      });
    } else {
      payload = await this.transport.form(
        endpoint,
        {
          ...data,
          ...(supplier === "codex" ? { scope: "openid profile email" } : {}),
          ...(supplier === "antigravity" ? { client_secret: GOOGLE_CLIENT_SECRET } : {}),
        },
        signal,
        this.headers(supplier, previous.deviceId),
      );
    }
    // 保留未轮换的 refresh token 和组织资料；不能将缺省字段覆盖成 undefined。
    const renewed = this.tokens(payload);
    const present = Object.fromEntries(
      Object.entries(renewed).filter(([, value]) => value !== undefined),
    );
    return {
      ...previous,
      ...present,
      accessToken: renewed.accessToken,
      expiresAt: renewed.expiresAt,
      tokenEndpoint: endpoint,
    };
  }

  private async discoverXai(signal: AbortSignal) {
    const result = await this.transport.request(
      "https://auth.x.ai/.well-known/openid-configuration",
      {},
      signal,
    );
    return {
      deviceEndpoint: xaiEndpoint(result.device_authorization_endpoint),
      tokenEndpoint: xaiEndpoint(result.token_endpoint),
    };
  }

  private headers(supplier: ProviderOAuthSupplier, deviceId?: string): Record<string, string> {
    if (supplier === "meta") return { "user-agent": "muse-code/1.0.2" };
    if (supplier !== "kimi" && supplier !== "kimi-ai") return {};
    return {
      "X-Msh-Platform": "FCode",
      "X-Msh-Version": "1.0.0",
      "X-Msh-Device-Name": hostname(),
      "X-Msh-Device-Model": `${process.platform}/${process.arch}`,
      ...(deviceId ? { "X-Msh-Device-Id": deviceId } : {}),
    };
  }

  private tokens(payload: OAuthObject): ProviderOAuthTokens {
    const accessToken = requiredString(payload.access_token);
    const idToken = string(payload.id_token);
    // JWT 声明仅作已交换凭据的显示资料，不能用作本地鉴权判断。
    let claims: OAuthObject = {};
    try {
      claims = object(
        JSON.parse(
          Buffer.from((idToken ?? accessToken).split(".")[1] ?? "", "base64url").toString("utf8"),
        ),
      );
    } catch {
      /* 允许厂商使用 opaque access token。 */
    }
    const account = object(payload.account);
    const organization = object(payload.organization);
    const openai = object(claims["https://api.openai.com/auth"]);
    const seconds = positiveNumber(payload.expires_in);
    if (payload.expires_in !== undefined && seconds === undefined) {
      throw new ProviderOAuthError("invalid_response");
    }
    return {
      accessToken,
      refreshToken: string(payload.refresh_token),
      idToken,
      expiresAt: seconds ? this.now() + seconds * 1000 : undefined,
      accountIdentity:
        string(account.uuid) ?? string(openai.chatgpt_account_id) ?? string(claims.sub),
      email: string(account.email_address) ?? string(claims.email),
      organizationId: string(organization.uuid),
    };
  }
}
