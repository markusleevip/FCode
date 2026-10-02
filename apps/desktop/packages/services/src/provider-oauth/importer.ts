import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { PROVIDER_OAUTH_SUPPLIERS, type ProviderAccountSupplier } from "./contract.js";
import {
  ProviderOAuthTransport,
  positiveNumber,
  requiredString,
  xaiEndpoint,
} from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthTokens } from "./types.js";
import { metaApiBaseUrl, mintMetaCredentials } from "./metaCredentials.js";
import { prepareAntigravityProject } from "./antigravityProject.js";

const text = z.string().trim().min(1);
const optionalText = text.optional();
const accountFile = z.object({
  type: z.enum(PROVIDER_OAUTH_SUPPLIERS.map((item) => item.id)),
  access_token: optionalText,
  refresh_token: optionalText,
  id_token: optionalText,
  api_key: optionalText,
  session_token: optionalText,
  dca_token: optionalText,
  base_url: optionalText,
  account_id: optionalText,
  user_id: optionalText,
  sub: optionalText,
  organization_id: optionalText,
  org_id: optionalText,
  project_id: optionalText,
  email: optionalText,
  name: optionalText,
  user_name: optionalText,
  expired: z.string().optional(),
  device_id: optionalText,
  device_seed: optionalText,
  token_endpoint: optionalText,
});
const serviceAccountFile = z.object({
  type: z.literal("service_account"),
  project_id: text.regex(/^[a-z][a-z0-9-]{3,62}$/),
  client_email: z.email(),
  private_key: text,
});
const vertexFile = z.object({
  type: z.literal("vertex"),
  service_account: serviceAccountFile,
  location: optionalText,
});
const locationSchema = text.regex(/^(global|[a-z]+(?:-[a-z]+)+[0-9])$/);

export interface ImportedProviderAccount {
  supplier: ProviderAccountSupplier;
  displayName: string;
  tokens: ProviderOAuthTokens;
}

export class ProviderOAuthImporter {
  private readonly transport: ProviderOAuthTransport;
  private readonly now: () => number;
  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.transport = new ProviderOAuthTransport(options.fetch ?? globalThis.fetch);
    this.now = options.now ?? Date.now;
  }

  async parse(
    input: { json: string; location?: string },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ImportedProviderAccount> {
    let parsed: unknown;
    try {
      if (typeof input.json !== "string" || Buffer.byteLength(input.json, "utf8") > 1_048_576)
        throw new Error();
      parsed = JSON.parse(input.json);
    } catch {
      throw new ProviderOAuthError("invalid_import");
    }
    const wrapped = vertexFile.safeParse(parsed);
    const raw = serviceAccountFile.safeParse(parsed);
    if (wrapped.success || raw.success) {
      const serviceAccount = wrapped.success ? wrapped.data.service_account : raw.data!;
      let tokens: ProviderOAuthTokens;
      try {
        const privateKey = createPrivateKey(serviceAccount.private_key);
        if (privateKey.asymmetricKeyType !== "rsa") throw new Error();
        tokens = {
          accessToken: "pending-service-account-exchange",
          privateKey: serviceAccount.private_key,
          clientEmail: serviceAccount.client_email,
          email: serviceAccount.client_email,
          accountIdentity: serviceAccount.client_email,
          projectId: serviceAccount.project_id,
          location: locationSchema.parse(
            input.location ?? (wrapped.success ? wrapped.data.location : undefined) ?? "global",
          ),
        };
      } catch {
        throw new ProviderOAuthError("invalid_import");
      }
      return {
        supplier: "vertex",
        displayName: serviceAccount.client_email,
        tokens: await this.refreshVertex(tokens, signal),
      };
    }
    const result = accountFile.safeParse(parsed);
    if (!result.success) throw new ProviderOAuthError("invalid_import");
    const file = result.data;
    let expiresAt: number | undefined;
    if (file.expired) {
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(file.expired))
        throw new ProviderOAuthError("invalid_import");
      expiresAt = Date.parse(file.expired);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0)
        throw new ProviderOAuthError("invalid_import");
    }
    let accessToken =
      file.type === "meta"
        ? (file.api_key ?? file.access_token ?? file.dca_token)
        : file.type === "devin"
          ? (file.session_token ?? file.access_token)
          : file.access_token;
    if (!accessToken) throw new ProviderOAuthError("invalid_import");
    if (file.type === "devin" && !accessToken.startsWith("devin-session-token$"))
      accessToken = `devin-session-token$${accessToken}`;
    // 上游 Devin 使用 device_seed；转换到既有私有设备字段，避免导入后每次更换指纹。
    const deviceId = file.type === "devin" ? (file.device_seed ?? file.device_id) : file.device_id;
    let tokens: ProviderOAuthTokens = {
      accessToken,
      ...(file.refresh_token ? { refreshToken: file.refresh_token } : {}),
      ...(file.id_token ? { idToken: file.id_token } : {}),
      ...(expiresAt && !(file.type === "meta" && file.api_key) ? { expiresAt } : {}),
      ...(file.email ? { email: file.email } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(file.dca_token ? { dcaToken: file.dca_token } : {}),
      ...(file.type === "meta" ? { apiBaseUrl: metaApiBaseUrl(file.base_url) } : {}),
      ...((file.account_id ?? file.user_id ?? file.sub)
        ? { accountIdentity: file.account_id ?? file.user_id ?? file.sub }
        : {}),
      ...((file.organization_id ?? file.org_id)
        ? { organizationId: file.organization_id ?? file.org_id }
        : {}),
      ...(file.project_id ? { projectId: file.project_id } : {}),
      ...(file.type === "xai" && file.token_endpoint
        ? { tokenEndpoint: xaiEndpoint(file.token_endpoint) }
        : {}),
    };
    if (file.type === "meta" && file.dca_token && !file.api_key) {
      tokens = await mintMetaCredentials(this.transport, tokens, signal);
    }
    if (file.type === "antigravity")
      tokens = await prepareAntigravityProject(this.transport, tokens, signal);
    return {
      supplier: file.type,
      tokens,
      displayName: file.email ?? file.name ?? file.user_name ?? file.type,
    };
  }

  async refreshVertex(
    tokens: ProviderOAuthTokens,
    signal: AbortSignal,
  ): Promise<ProviderOAuthTokens> {
    if (!tokens.privateKey || !tokens.clientEmail || !tokens.projectId)
      throw new ProviderOAuthError("invalid_import");
    const issued = Math.floor(this.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: tokens.clientEmail,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: issued,
        exp: issued + 3600,
      }),
    ).toString("base64url");
    const unsigned = `${header}.${claims}`;
    let signature: string;
    try {
      signature = sign("RSA-SHA256", Buffer.from(unsigned), tokens.privateKey).toString(
        "base64url",
      );
    } catch {
      throw new ProviderOAuthError("invalid_import");
    }
    const response = await this.transport.form(
      "https://oauth2.googleapis.com/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      },
      signal,
    );
    const expiresIn = positiveNumber(response.expires_in);
    if (!expiresIn) throw new ProviderOAuthError("invalid_response");
    return {
      ...tokens,
      accessToken: requiredString(response.access_token),
      expiresAt: this.now() + expiresIn * 1000,
    };
  }
}
