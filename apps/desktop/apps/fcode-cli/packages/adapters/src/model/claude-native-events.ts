import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import { messagesRecord as record } from "./messages-native-stream.js";

type JsonRecord = Record<string, unknown>;
const MAX_SIGNATURE_CHARS = 8 * 1024 * 1024;

/** Per-response event profile; the shared Messages transform still owns frame/terminal state. */
export function createClaudeEventNormalizer(
  restoreTools: (event: JsonRecord) => JsonRecord,
): (event: JsonRecord) => JsonRecord {
  const signatures = new Map<number, string>();
  return (event) => {
    const next = restoreTools(event);
    const delta = record(next.delta);
    if (next.type === "content_block_delta" && delta?.type === "signature_delta") {
      if (typeof next.index !== "number" || typeof delta.signature !== "string")
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          "Claude signature delta is invalid",
        );
      // SDK 每片发 metadata，Core 的 providerOptions 是覆盖语义；累积后投影，避免只回放最后一片。
      const previous = signatures.get(next.index) ?? "";
      if (previous.length + delta.signature.length > MAX_SIGNATURE_CHARS)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          "Claude signature exceeds its limit",
        );
      const signature = previous + delta.signature;
      signatures.set(next.index, signature);
      return { ...next, delta: { ...delta, signature } };
    }
    if (next.type === "content_block_stop" && typeof next.index === "number")
      signatures.delete(next.index);
    if (next.type === "message_stop") signatures.clear();
    return next;
  };
}
