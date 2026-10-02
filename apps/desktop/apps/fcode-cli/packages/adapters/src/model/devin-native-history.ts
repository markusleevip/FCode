import { devinFailure, devinRecord, DEVIN_MAX_VALUE } from "./devin-native-protobuf.js";
export interface DevinPrompt {
  source: number;
  content: string;
  thinking?: string;
  signature?: Buffer;
  signatureType?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  images?: { data: string; mime: string }[];
}
const PREFIX = "devin.v1:";
export const packDevinSignature = (bytes: Uint8Array, type: string) =>
  `${PREFIX}${Buffer.from(type).toString("base64")}:${Buffer.from(bytes).toString("base64")}`;
function signature(value: unknown): { signature?: Buffer; signatureType?: string } {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return {};
  const parts = value.slice(PREFIX.length).split(":");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part),
    )
  )
    devinFailure("requires a valid signed history envelope", true);
  const bytes = Buffer.from(parts[1], "base64");
  if (bytes.length > DEVIN_MAX_VALUE) devinFailure("history signature exceeds the limit", true);
  return { signature: bytes, signatureType: Buffer.from(parts[0], "base64").toString("utf8") };
}
function image(raw: Record<string, unknown>): { data: string; mime: string } {
  const source = devinRecord(raw.source);
  if (
    source?.type !== "base64" ||
    typeof source.data !== "string" ||
    typeof source.media_type !== "string" ||
    !source.media_type.startsWith("image/")
  )
    devinFailure("requires embedded base64 image input", true);
  return { data: source.data, mime: source.media_type };
}
export function devinHistory(body: Record<string, unknown>): DevinPrompt[] {
  if (!Array.isArray(body.messages)) devinFailure("requires Messages history", true);
  const prompts: DevinPrompt[] = [];
  const pending = new Set<string>();
  for (const raw of body.messages) {
    const message = devinRecord(raw);
    if (!message || !["user", "assistant"].includes(String(message.role)))
      devinFailure("received an invalid history role", true);
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(content)) devinFailure("requires content blocks", true);
    let current: DevinPrompt = { source: message.role === "assistant" ? 2 : 1, content: "" };
    const flush = () => {
      if (
        current.content ||
        current.thinking !== undefined ||
        current.toolCalls?.length ||
        current.images?.length
      )
        prompts.push(current);
      current = { source: message.role === "assistant" ? 2 : 1, content: "" };
    };
    for (const value of content) {
      const part = devinRecord(value);
      if (!part) devinFailure("received an invalid history block", true);
      if (part.type === "text" && typeof part.text === "string") current.content += part.text;
      else if (part.type === "image") (current.images ??= []).push(image(part));
      else if (
        part.type === "thinking" &&
        current.source === 2 &&
        typeof part.thinking === "string"
      ) {
        if (current.thinking !== undefined) flush();
        current.thinking = part.thinking;
        Object.assign(current, signature(part.signature));
      } else if (
        part.type === "tool_use" &&
        current.source === 2 &&
        typeof part.id === "string" &&
        part.id &&
        typeof part.name === "string" &&
        part.name
      ) {
        if (pending.has(part.id)) devinFailure("received duplicate history tool IDs", true);
        pending.add(part.id);
        (current.toolCalls ??= []).push({
          id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      } else if (
        part.type === "tool_result" &&
        current.source === 1 &&
        typeof part.tool_use_id === "string"
      ) {
        if (!pending.delete(part.tool_use_id)) devinFailure("received an orphan tool result", true);
        flush();
        const result: DevinPrompt = { source: 4, content: "", toolCallId: part.tool_use_id };
        if (typeof part.content === "string") result.content = part.content;
        else if (Array.isArray(part.content))
          for (const item of part.content) {
            const child = devinRecord(item);
            if (child?.type === "text" && typeof child.text === "string")
              result.content += child.text;
            else if (child?.type === "image") (result.images ??= []).push(image(child));
            else devinFailure("cannot represent this tool result block", true);
          }
        else if (part.content !== undefined)
          devinFailure("cannot represent this tool result", true);
        prompts.push(result);
      } else devinFailure("cannot represent this history block", true);
    }
    flush();
  }
  return prompts;
}
