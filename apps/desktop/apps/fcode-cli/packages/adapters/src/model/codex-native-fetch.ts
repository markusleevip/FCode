import { normalizeCodexRequest } from "./codex-native-request.js";
import { createResponsesNativeFetch } from "./responses-native-fetch.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";

export function createCodexNativeFetch(
  baseFetch: typeof fetch,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  return createResponsesNativeFetch(
    baseFetch,
    {
      supplier: "codex",
      normalizeRequest: normalizeCodexRequest,
      patchHeaders(headers) {
        if (!headers.has("originator")) headers.set("originator", "fcode");
      },
    },
    capture,
  );
}
