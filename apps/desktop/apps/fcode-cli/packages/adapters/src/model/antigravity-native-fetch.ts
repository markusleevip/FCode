import { createGeminiNativeFetch } from "./gemini-native-fetch.js";
import {
  prepareAntigravityRequest,
  ANTIGRAVITY_STREAM_PATH,
} from "./antigravity-native-request.js";
import type { RawRequestBodyCapture } from "./model-option-map-fetch.js";
import { ANTIGRAVITY_NATIVE_INFERENCE_ORIGIN } from "@fcode/shared";

export function createAntigravityNativeFetch(
  baseFetch: typeof fetch,
  token: string,
  capture?: RawRequestBodyCapture,
): typeof fetch {
  return createGeminiNativeFetch(
    baseFetch,
    token,
    {
      supplier: "antigravity",
      prepare(body, headers, credential) {
        return {
          ...prepareAntigravityRequest(body, headers, credential),
          target(url) {
            // 旧默认绑定误用了控制面 origin；固定迁移到推理面，不按网络错误跨域重试。
            if (url.origin === "https://cloudcode-pa.googleapis.com")
              url.hostname = new URL(ANTIGRAVITY_NATIVE_INFERENCE_ORIGIN).hostname;
            url.pathname = ANTIGRAVITY_STREAM_PATH;
            url.search = "?alt=sse";
            url.hash = "";
            return url;
          },
        };
      },
    },
    capture,
  );
}
