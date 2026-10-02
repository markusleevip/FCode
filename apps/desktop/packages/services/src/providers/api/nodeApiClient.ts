import {
  ApiError,
  DEFAULT_FCODE_ENDPOINT_ORIGIN,
  normalizeFCodeEndpointOrigin,
  rewriteFCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@fcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildFCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

const log = createServiceLogger("node-api-client");

interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  onFcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isFcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  resolveFCodeEndpointOrigin?: () => Promise<string> | string;
}

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeFCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

function withFCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] {
  const next = new Headers(buildFCodeSourceHeaders());
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

  if (next.get("HTTP-Referer") === DEFAULT_FCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // FCode 后端请求以前只有部分业务路径手动补来源头。
  // 统一在 ApiClient 出口按 endpoint origin 注入，避免 OAuth/config/billing/snapshot 等链路遗漏。
  return withFCodeEndpointHeaders(headers, endpointOrigin);
}

export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveFCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly onFcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isFcodeJwtRequest?: NodeApiClientOptions["isFcodeJwtRequest"];

  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.onFcodeJwtInvalid = options.onFcodeJwtInvalid;
    this.isFcodeJwtRequest = options.isFcodeJwtRequest;
    this.resolveFCodeEndpointOrigin = options.resolveFCodeEndpointOrigin;
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveFCodeEndpointOrigin
      ? await this.resolveFCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_FCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteFCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(requestInput, init?.headers, activeEndpointOrigin),
      );
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // 调试说明：这里只记录 header key，避免 Authorization / token 等敏感值落盘。
        log.debug(undefined, "fcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      const response = await fetchImpl(requestInput, {
        ...init,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
      if (response.status === 401) {
        try {
          if (await this.isFcodeJwtRequest?.(requestInput, new Headers(requestHeaders))) {
            this.onFcodeJwtInvalid?.(requestInput, new Headers(requestHeaders));
          }
        } catch (error) {
          log.warn("fcode jwt invalid response observation failed", { error });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
