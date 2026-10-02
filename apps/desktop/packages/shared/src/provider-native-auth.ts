/** Internal Host → Agent requestAuth metadata; consumed before any vendor transport. */
export const CLAUDE_NATIVE_ACCOUNT_HEADER = "X-FCode-Claude-Account-Id";
export const DEVIN_NATIVE_DEVICE_HEADER = "X-FCode-Devin-Device-Id";
/** Explicit UID from account catalog; bypasses legacy alias/effort rewriting. */
export const DEVIN_NATIVE_MODEL_UID_PREFIX = "devin/uid:";
export const DEVIN_NATIVE_MODEL_UID_MAX_TOKENS = 64000;
export const ANTIGRAVITY_NATIVE_PROJECT_HEADER = "X-FCode-Antigravity-Project-Id";
/** Control-plane calls remain on cloudcode-pa; native inference has its own origin. */
export const ANTIGRAVITY_NATIVE_INFERENCE_ORIGIN = "https://daily-cloudcode-pa.googleapis.com";
export const VERTEX_NATIVE_PROJECT_HEADER = "X-FCode-Vertex-Project-Id";
export const VERTEX_NATIVE_LOCATION_HEADER = "X-FCode-Vertex-Location";
