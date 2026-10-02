import {
  geminiRecord,
  geminiFailure,
  type NativeRecord,
  type GeminiNativeSupplier,
} from "./gemini-native-tools.js";
const MAX_SIGNATURE_CHARS = 8 * 1024 * 1024;
export interface GeminiNativeSignature {
  model: string;
  signature: string;
  target: "thinking" | "function" | "text";
  callId?: string;
  text?: string;
}
export function packGeminiNativeSignature(
  value: GeminiNativeSignature,
  supplier: GeminiNativeSupplier,
): string {
  if (value.signature.length > MAX_SIGNATURE_CHARS) geminiFailure("signature exceeds its limit");
  return `${supplier}.v1:` + Buffer.from(JSON.stringify(value)).toString("base64url");
}
function signature(
  raw: unknown,
  model: string,
  supplier: GeminiNativeSupplier,
): GeminiNativeSignature | undefined {
  const SIGNATURE_PREFIX = `${supplier}.v1:`;
  if (typeof raw !== "string" || !raw.startsWith(SIGNATURE_PREFIX)) return undefined;
  if (raw.length > MAX_SIGNATURE_CHARS * 2)
    geminiFailure("history signature exceeds its limit", true);
  try {
    const value = geminiRecord(
      JSON.parse(Buffer.from(raw.slice(SIGNATURE_PREFIX.length), "base64url").toString("utf8")),
    );
    if (
      !value ||
      typeof value.signature !== "string" ||
      value.signature.length > MAX_SIGNATURE_CHARS ||
      !["thinking", "function", "text"].includes(String(value.target))
    )
      throw new Error();
    if (value.model !== model) return undefined;
    return value as unknown as GeminiNativeSignature;
  } catch {
    return geminiFailure("history signature is invalid", true);
  }
}
function textParts(value: unknown): NativeRecord[] {
  if (typeof value === "string") return [{ text: value }];
  if (!Array.isArray(value)) geminiFailure("text content is unsupported", true);
  return value.map((entry) => {
    const block = geminiRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") return { text: block.text };
    if (block?.type === "image") {
      const source = geminiRecord(block.source);
      if (
        source?.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      )
        return { inlineData: { data: source.data, mimeType: source.media_type } };
    }
    return geminiFailure("content cannot be represented", true);
  });
}
function attachTextSignatures(parts: NativeRecord[], carriers: GeminiNativeSignature[]) {
  let cursor = 0;
  for (const signed of carriers) {
    if (typeof signed.text !== "string")
      geminiFailure("text signature carrier has no matching part", true);
    let matched = false;
    for (let index = cursor; index < parts.length; index++) {
      const part = parts[index];
      if (typeof part.text !== "string" || part.thought === true || part.thoughtSignature) continue;
      const offset = part.text.indexOf(signed.text);
      if (offset < 0) continue;
      const prefix = part.text.slice(0, offset),
        suffix = part.text.slice(offset + signed.text.length);
      parts.splice(
        index,
        1,
        ...(prefix ? [{ ...part, text: prefix }] : []),
        { text: signed.text, thoughtSignature: signed.signature },
        ...(suffix ? [{ ...part, text: suffix }] : []),
      );
      cursor = index + (prefix ? 2 : 1);
      matched = true;
      break;
    }
    if (!matched) geminiFailure("text signature carrier has no matching part", true);
  }
}
export function geminiNativeHistory(
  body: NativeRecord,
  model: string,
  alias: (name: string) => string,
  supplier: GeminiNativeSupplier,
) {
  if (!Array.isArray(body.messages)) geminiFailure("requires message history", true);
  const contents: NativeRecord[] = [];
  const calls = new Map<string, string>(),
    signatures = new Map<string, string>();
  for (const entry of body.messages) {
    const message = geminiRecord(entry);
    if (!message || !["user", "assistant"].includes(String(message.role)))
      geminiFailure("history role is unsupported", true);
    const parts: NativeRecord[] = [];
    const textSignatures: GeminiNativeSignature[] = [];
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(blocks)) geminiFailure("history content is invalid", true);
    for (const entry of blocks) {
      const block = geminiRecord(entry);
      if (!block) geminiFailure("history block is invalid", true);
      if (block.type === "thinking") {
        const signed = signature(block.signature, model, supplier);
        if (signed?.target === "function" && signed.callId)
          signatures.set(signed.callId, signed.signature);
        else if (signed?.target === "text") {
          // Runtime 将 reasoning 载体置于聚合文本前；在本消息构造完后按原片段恢复签名。
          textSignatures.push(signed);
        } else if (typeof block.thinking === "string")
          parts.push({
            text: block.thinking,
            thought: true,
            ...(signed ? { thoughtSignature: signed.signature } : {}),
          });
      } else if (block.type === "tool_use") {
        if (
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !geminiRecord(block.input) ||
          calls.has(block.id)
        )
          geminiFailure("history tool call is invalid", true);
        const name = alias(block.name);
        calls.set(block.id, name);
        const nativeSignature = signatures.get(block.id);
        parts.push({
          functionCall: { id: block.id, name, args: block.input },
          ...(nativeSignature ? { thoughtSignature: nativeSignature } : {}),
        });
        signatures.delete(block.id);
      } else if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || !calls.has(block.tool_use_id))
          geminiFailure("history tool result has no call", true);
        const content = textParts(block.content ?? "");
        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name: calls.get(block.tool_use_id),
            response: { [block.is_error ? "error" : "output"]: content },
          },
        });
        calls.delete(block.tool_use_id);
      } else parts.push(...textParts([block]));
    }
    attachTextSignatures(parts, textSignatures);
    if (parts.length) {
      const role = message.role === "assistant" ? "model" : "user";
      const previous = contents.at(-1);
      if (previous?.role === role) (previous.parts as NativeRecord[]).push(...parts);
      else contents.push({ role, parts });
    }
  }
  if (signatures.size) geminiFailure("signature carrier has no matching tool call", true);
  return {
    contents,
    ...(body.system !== undefined
      ? { systemInstruction: { role: "user", parts: textParts(body.system) } }
      : {}),
  };
}
