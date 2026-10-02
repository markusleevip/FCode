import { devinFailure, devinRecord } from "./devin-native-protobuf.js";
import { DEVIN_CHAT_PATH, prepareDevinRequest } from "./devin-native-request.js";
import { createDevinStreamTransform } from "./devin-native-stream.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";

export function createDevinNativeFetch(
  baseFetch: typeof fetch,
  token: string,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  return async (input, init) => {
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request && init?.body == null
          ? await input.clone().text()
          : undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = raw === undefined ? undefined : devinRecord(JSON.parse(raw));
    } catch {
      devinFailure("requires a JSON logical request", true);
    }
    if (!body) devinFailure("requires a JSON logical request", true);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const request = prepareDevinRequest(body, token, headers);
    if (capture) capture.body = request.capture as NonNullable<RawRequestBodyCapture["body"]>;
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.pathname = DEVIN_CHAT_PATH;
    url.search = "";
    url.hash = "";
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const requestInit = { ...init, method: "POST", headers, body: new Uint8Array(request.bytes) };
    const response = await baseFetch(
      input instanceof Request ? new Request(new Request(url, input), requestInit) : url,
      input instanceof Request ? undefined : requestInit,
    );
    if (!response.ok) return response;
    if (
      !response.body ||
      !response.headers.get("content-type")?.toLowerCase().includes("application/connect+proto")
    )
      devinFailure("returned an invalid Connect response");
    let terminal: Record<string, unknown> | undefined;
    const stream = response.body.pipeThrough(
      createDevinStreamTransform(request.model, (value) => {
        terminal = value;
      }),
      signal ? { signal } : undefined,
    );
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    if (body.stream === true) {
      responseHeaders.set("content-type", "text/event-stream");
      return new Response(stream, { status: response.status, headers: responseHeaders });
    }
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        /* The Connect frame owner validates the terminal result. */
      }
    } finally {
      reader.releaseLock();
    }
    if (!terminal) devinFailure("did not complete its response");
    responseHeaders.set("content-type", "application/json");
    return Response.json(terminal, { status: response.status, headers: responseHeaders });
  };
}
