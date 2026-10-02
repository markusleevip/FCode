import { ProviderOAuthError } from "./types.js";

export type OAuthObject = Record<string, unknown>;

export function object(value: unknown): OAuthObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OAuthObject)
    : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requiredString(value: unknown): string {
  const result = string(value);
  if (!result) throw new ProviderOAuthError("invalid_response");
  return result;
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function httpsUrl(value: unknown): string {
  try {
    const url = new URL(requiredString(value));
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {
    /* 厂商响应不进入错误信息。 */
  }
  throw new ProviderOAuthError("invalid_endpoint");
}

export function xaiEndpoint(value: unknown): string {
  const raw = httpsUrl(value);
  const url = new URL(raw);
  if ((url.hostname === "x.ai" || url.hostname.endsWith(".x.ai")) && !url.port) return raw;
  throw new ProviderOAuthError("invalid_endpoint");
}

const ERROR_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
]);

export class ProviderOAuthTransport {
  constructor(private readonly fetcher: typeof fetch) {}

  private async read(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<{ response: Response; bytes: Buffer }> {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers)) },
      });
    } catch {
      throw new ProviderOAuthError(signal.aborted ? "cancelled" : "network_error");
    }
    // 限制返回体；错误正文可能含凭据，既不记录也不返回 RPC。
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderOAuthError("invalid_response", response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new ProviderOAuthError("cancelled");
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new ProviderOAuthError("invalid_response", response.status);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ProviderOAuthError) throw error;
      throw new ProviderOAuthError(signal.aborted ? "cancelled" : "network_error");
    } finally {
      reader.releaseLock();
    }
    return { response, bytes: Buffer.concat(chunks) };
  }

  async binary(url: string, init: RequestInit, signal: AbortSignal): Promise<Buffer> {
    const { response, bytes } = await this.read(url, init, signal);
    if (!response.ok) throw new ProviderOAuthError("provider_error", response.status);
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/proto"
    )
      throw new ProviderOAuthError("invalid_response", response.status);
    return bytes;
  }

  async request(url: string, init: RequestInit, signal: AbortSignal): Promise<OAuthObject> {
    const { response, bytes } = await this.read(url, init, signal);
    let payload: OAuthObject;
    try {
      payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      throw new ProviderOAuthError("invalid_response", response.status);
    }
    if (!response.ok || payload.error) {
      const code =
        typeof payload.error === "string" && ERROR_CODES.has(payload.error)
          ? payload.error
          : "provider_error";
      throw new ProviderOAuthError(code, response.status);
    }
    return payload;
  }

  form(url: string, data: Record<string, string>, signal: AbortSignal, headers = {}) {
    return this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(data).toString(),
      },
      signal,
    );
  }

  json(url: string, data: OAuthObject, signal: AbortSignal, headers = {}) {
    return this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      },
      signal,
    );
  }
}
