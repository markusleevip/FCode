import {
  geminiRecord,
  geminiFailure,
  type NativeRecord,
  type GeminiNativeSupplier,
} from "./gemini-native-tools.js";
import { createGeminiNativeStream } from "./gemini-native-stream.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";
export interface GeminiNativeProfile {
  readonly supplier: GeminiNativeSupplier;
  prepare(
    body: NativeRecord,
    headers: Headers,
    token: string,
  ): {
    model: string;
    body: NativeRecord;
    original(name: string): string;
    target(url: URL): URL;
  };
}
export function createGeminiNativeFetch(
  baseFetch: typeof fetch,
  token: string,
  profile: GeminiNativeProfile,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  return async (input, init) => {
    const original =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request && init?.body == null
          ? await input.clone().text()
          : undefined;
    let body: NativeRecord | undefined;
    try {
      body = original === undefined ? undefined : geminiRecord(JSON.parse(original));
    } catch {
      /* never expose request data */
    }
    if (!body) geminiFailure("requires a JSON model request", true);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const prepared = profile.prepare(body, headers, token);
    if (capture) capture.body = prepared.body as NonNullable<RawRequestBodyCapture["body"]>;
    const url = prepared.target(new URL(input instanceof Request ? input.url : String(input)));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const requestInit = { ...init, headers, body: JSON.stringify(prepared.body), signal };
    const response = await baseFetch(
      input instanceof Request ? new Request(new Request(url, input), requestInit) : url,
      input instanceof Request ? undefined : requestInit,
    );
    if (!response.ok) return response;
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      geminiFailure("requires a streaming response");
    let message: NativeRecord | undefined;
    const stream = response.body.pipeThrough(
      createGeminiNativeStream({
        supplier: profile.supplier,
        ...prepared,
        onFinal: (value) => {
          message = value;
        },
      }),
      signal ? { signal } : undefined,
    );
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete("content-length");
    resultHeaders.delete("content-encoding");
    if (body.stream === true)
      return new Response(stream, { status: response.status, headers: resultHeaders });
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        /* terminal owner captures the final Message */
      }
    } finally {
      reader.releaseLock();
    }
    if (!message) geminiFailure("did not produce a final message");
    resultHeaders.set("content-type", "application/json");
    return Response.json(message, { status: response.status, headers: resultHeaders });
  };
}
