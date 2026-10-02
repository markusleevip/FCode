import { createGeminiNativeFetch } from "./gemini-native-fetch.js";
import { prepareVertexRequest } from "./vertex-native-request.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";

export function createVertexNativeFetch(
  baseFetch: typeof fetch,
  token: string,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  return createGeminiNativeFetch(
    baseFetch,
    token,
    { supplier: "vertex", prepare: prepareVertexRequest },
    capture,
  );
}
