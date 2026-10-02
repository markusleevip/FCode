// GetChatMessage request codec adapted from CLIProxyAPI (MIT).
import { createHash, randomUUID } from "node:crypto";
import { createDevinClientMetadata } from "@fcode/shared/node";
import {
  devinBytes as bytes,
  devinInteger as integer,
  devinDouble,
  devinEnvelope,
  devinFailure,
  devinRecord,
} from "./devin-native-protobuf.js";
import { devinHistory } from "./devin-native-history.js";
import { resolveDevinModel } from "./devin-native-model.js";
import { DEVIN_NATIVE_DEVICE_HEADER } from "@fcode/shared";
const DEFAULT_TOKENS = 128000;
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
function uuid(value: string): string {
  if (!value) return randomUUID();
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) return value;
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex"))
    .update(value)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function prepareDevinRequest(
  body: Record<string, unknown>,
  token: string,
  headers: Headers,
) {
  const choice = devinRecord(body.tool_choice)?.type;
  if (choice !== undefined && !["auto", "none"].includes(String(choice)))
    devinFailure("cannot represent forced tool selection", true);
  const metadata = devinRecord(body.metadata);
  let identity: Record<string, unknown> | undefined;
  if (typeof metadata?.user_id === "string") {
    try {
      identity = devinRecord(JSON.parse(metadata.user_id));
    } catch {
      devinFailure("requires valid native session metadata", true);
    }
  }
  const session = uuid(typeof identity?.session_id === "string" ? identity.session_id : "");
  const seed = headers.get(DEVIN_NATIVE_DEVICE_HEADER) ?? "";
  headers.delete(DEVIN_NATIVE_DEVICE_HEADER);
  const prompts = devinHistory(body);
  const thinking = devinRecord(body.thinking);
  const model = resolveDevinModel(
    String(body.model ?? ""),
    String(body.reasoning_effort ?? devinRecord(body.output_config)?.effort ?? ""),
    typeof thinking?.budget_tokens === "number" ? thinking.budget_tokens : 0,
  );
  const requested = body.max_tokens ?? body.max_output_tokens ?? DEFAULT_TOKENS;
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested <= 0)
    devinFailure("requires a positive completion limit", true);
  const maxTokens = Math.min(requested, model.maxTokens);
  const temperature = body.temperature ?? 1;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0)
    devinFailure("requires a valid temperature", true);
  const metadataBytes = createDevinClientMetadata(token, seed);
  const output: Buffer[] = [bytes(1, metadataBytes)];
  if (body.system !== undefined) {
    const system =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
              .map((part) => {
                const value = devinRecord(part);
                if (value?.type !== "text" || typeof value.text !== "string")
                  devinFailure("requires text system instructions", true);
                return value.text;
              })
              .join("\n")
          : devinFailure("requires text system instructions", true);
    if (system) output.push(bytes(2, system));
  }
  for (const [index, prompt] of prompts.entries()) {
    const parts = [
      bytes(1, uuid(`${session}:${index}`)),
      integer(2, prompt.source),
      bytes(3, prompt.content),
    ];
    for (const call of prompt.toolCalls ?? [])
      parts.push(
        bytes(6, Buffer.concat([bytes(1, call.id), bytes(2, call.name), bytes(3, call.arguments)])),
      );
    if (prompt.toolCallId) parts.push(bytes(7, prompt.toolCallId));
    for (const image of prompt.images ?? [])
      parts.push(bytes(10, Buffer.concat([bytes(1, image.data), bytes(2, image.mime)])));
    if (prompt.thinking !== undefined) parts.push(bytes(11, prompt.thinking));
    if (prompt.signature?.length) parts.push(bytes(12, prompt.signature));
    if (prompt.signatureType) parts.push(bytes(18, prompt.signatureType));
    output.push(bytes(3, Buffer.concat(parts)));
  }
  output.push(
    integer(7, 5),
    bytes(
      8,
      Buffer.concat([
        integer(1, 1),
        integer(2, maxTokens),
        integer(3, 400),
        devinDouble(5, temperature),
        integer(7, 40),
        devinDouble(8, Math.fround(0.95)),
      ]),
    ),
  );
  if (body.tools !== undefined && !Array.isArray(body.tools))
    devinFailure("requires an array of tools", true);
  const names = new Set<string>();
  if (choice !== "none")
    for (const raw of (body.tools as unknown[]) ?? []) {
      const tool = devinRecord(raw);
      if (
        !tool ||
        typeof tool.name !== "string" ||
        !tool.name ||
        (tool.type !== undefined && tool.type !== "custom") ||
        !devinRecord(tool.input_schema)
      )
        devinFailure("requires JSON function tools", true);
      if (names.has(tool.name)) devinFailure("requires unique tool names", true);
      names.add(tool.name);
      output.push(
        bytes(
          10,
          Buffer.concat([
            bytes(1, tool.name),
            bytes(2, typeof tool.description === "string" ? tool.description : ""),
            bytes(3, JSON.stringify(tool.input_schema)),
          ]),
        ),
      );
    }
  const ordinal = prompts.filter((prompt) => prompt.source === 2).length;
  const thread = [bytes(1, session), ...(ordinal ? [integer(2, ordinal)] : []), integer(3, 4)];
  if (prompts.at(-1)?.source === 1 && (!ordinal || prompts.at(-2)?.source !== 1))
    thread.push(integer(4, 14));
  output.push(
    bytes(15, Buffer.concat(thread)),
    bytes(16, session),
    integer(20, 1),
    bytes(21, model.uid),
  );
  headers.set("authorization", `Basic ${token}-${token}`);
  headers.delete("x-api-key");
  headers.delete("anthropic-beta");
  headers.delete("anthropic-version");
  headers.set("content-type", "application/connect+proto");
  headers.set("connect-protocol-version", "1");
  headers.set("connect-accept-encoding", "gzip");
  headers.set("accept", "*/*");
  headers.delete("content-length");
  return {
    bytes: devinEnvelope(Buffer.concat(output)),
    model: model.uid,
    capture: { ...body, model: model.uid, max_tokens: maxTokens },
  };
}
