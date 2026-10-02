import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import { normalizeKimiModel, applyKimiClientHeaders } from "./kimi-native-request.js";
import {
  createMessagesStreamTransform,
  messagesRecord,
  validateNativeMessage,
} from "./messages-native-stream.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";
import { claudeMessagesUrl, prepareClaudeNativeRequest } from "./claude-native-request.js";

export function createMessagesNativeFetch(
  baseFetch: typeof fetch,
  options: {
    supplier: string;
    token: string;
    capture?: RawRequestBodyCapture;
  },
): typeof fetch {
  return async (input, init) => {
    const original =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request && init?.body == null
          ? await input.clone().text()
          : undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = original === undefined ? undefined : messagesRecord(JSON.parse(original));
    } catch {
      /* Report a controlled protocol error below, never raw request content. */
    }
    if (!body || typeof body.model !== "string") {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "Native Messages requires a JSON model request",
      );
    }
    const kimi = options.supplier === "kimi" || options.supplier === "kimi-ai";
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const claude =
      options.supplier === "claude" ? prepareClaudeNativeRequest(body, headers) : undefined;
    const patched =
      claude?.body ?? (kimi ? { ...body, model: normalizeKimiModel(body.model) } : body);
    if (options.capture)
      options.capture.body = patched as NonNullable<RawRequestBodyCapture["body"]>;
    // OAuth access token 不能同时作为 x-api-key 发送，避免上游按错误的鉴权模式处理。
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${options.token}`);
    headers.set("content-type", "application/json");
    headers.set("accept", patched.stream === true ? "text/event-stream" : "application/json");
    headers.delete("content-length");
    if (kimi) applyKimiClientHeaders(headers);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const requestInit = { ...init, headers, body: JSON.stringify(patched) };
    const target = claude ? claudeMessagesUrl(input) : input;
    const response = await baseFetch(
      input instanceof Request ? new Request(new Request(target, input), requestInit) : target,
      input instanceof Request ? undefined : requestInit,
    );
    if (!response.ok) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    if (patched.stream === true) {
      if (
        !response.body ||
        !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
      ) {
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          "Native Messages streaming response requires events",
        );
      }
      return new Response(
        response.body.pipeThrough(
          createMessagesStreamTransform(claude?.restoreEvent),
          signal ? { signal } : undefined,
        ),
        { status: response.status, headers: responseHeaders },
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      // 读取响应 body 时取消也会使 json() 拒绝；不能把取消或网络断开改报为 JSON 协议错误。
      signal?.throwIfAborted();
      if (!(error instanceof SyntaxError)) throw error;
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        "Native Messages response requires JSON",
      );
    }
    const validated = validateNativeMessage(value);
    return Response.json(claude ? claude.restoreMessage(validated) : validated, {
      status: response.status,
      headers: responseHeaders,
    });
  };
}
