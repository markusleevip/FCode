import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import {
  asResponsesRecord,
  responsesSupplierLabel,
  type ResponsesNativeProfile,
} from "./responses-native-profile.js";
import {
  createResponsesStreamTransform,
  validateResponsesCompleted,
} from "./responses-native-stream.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";

/** Runs inside the existing Agent network transport; no local proxy or credential cache. */
export function createResponsesNativeFetch(
  baseFetch: typeof fetch,
  profile: ResponsesNativeProfile,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  const label = responsesSupplierLabel(profile.supplier);
  return async (input, init) => {
    const original =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request && init?.body == null
          ? await input.clone().text()
          : undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = original === undefined ? undefined : asResponsesRecord(JSON.parse(original));
    } catch {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `${label} requires a JSON request body`,
      );
    }
    if (!body)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `${label} requires a JSON request body`,
      );
    const streaming = body.stream === true;
    const patched = profile.normalizeRequest(body);
    if (capture) capture.body = patched as NonNullable<RawRequestBodyCapture["body"]>;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    profile.patchHeaders(headers);
    headers.delete("content-length");
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const requestInit = { ...init, headers, body: JSON.stringify(patched) };
    const response = await baseFetch(
      input instanceof Request ? new Request(input, requestInit) : input,
      input instanceof Request ? undefined : requestInit,
    );
    if (!response.ok) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    const contentType = response.headers.get("content-type");
    // Codex 实际上游会返回缺少 Content-Type 的合法 SSE；仍由同一个事件/终态
    // parser 验证内容，不能仅因响应头缺失拒绝，更不能把 HTTP 200 当作成功。
    const eventStream =
      contentType?.toLowerCase().includes("text/event-stream") ||
      (profile.supplier === "codex" && !contentType?.trim());
    if (!eventStream) {
      if (streaming)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} streaming response must contain events`,
        );
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} returned invalid JSON`,
        );
      }
      const value = validateResponsesCompleted(
        profile.normalizeJson?.(raw, patched) ?? raw,
        profile.supplier,
      );
      responseHeaders.set("content-type", "application/json");
      return Response.json(value, { status: response.status, headers: responseHeaders });
    }
    if (!response.body)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        `${label} returned an empty stream`,
      );
    responseHeaders.set("content-type", "text/event-stream");
    let terminal: Record<string, unknown> | undefined;
    const stream = response.body.pipeThrough(
      createResponsesStreamTransform(
        (value) => {
          terminal = value;
        },
        profile.supplier,
        profile.createEventNormalizer?.(patched),
      ),
      signal ? { signal } : undefined,
    );
    if (streaming)
      return new Response(stream, { status: response.status, headers: responseHeaders });
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        /* Consume validated events until the accepted completion. */
      }
    } finally {
      reader.releaseLock();
    }
    if (!terminal)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        `${label} response is missing its completion`,
      );
    responseHeaders.set("content-type", "application/json");
    return Response.json(terminal, { status: response.status, headers: responseHeaders });
  };
}
