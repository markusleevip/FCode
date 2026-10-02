import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { decodeDevinFrame, type DevinUsage } from "./devin-native-frame.js";
import { packDevinSignature } from "./devin-native-history.js";
import {
  DEVIN_MAX_FRAME,
  DEVIN_MAX_DECOMPRESSED_FRAME,
  DEVIN_MAX_VALUE,
  devinFailure,
  devinRecord,
} from "./devin-native-protobuf.js";
const decompress = promisify(gunzip);
const MAX_TOOLS = 128;
type Block = Record<string, unknown>;
interface Tool {
  id: string;
  name: string;
  args: string;
  index: number;
  started: boolean;
  decoder: TextDecoder;
}
export function createDevinStreamTransform(
  model: string,
  completed: (message: Record<string, unknown>) => void,
) {
  let buffer = Buffer.alloc(0),
    started = false,
    terminal = false,
    stop = 0;
  let messageId = "",
    textIndex: number | undefined,
    thinkingIndex: number | undefined;
  let signature = Buffer.alloc(0),
    signatureType = "";
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const thoughtDecoder = new TextDecoder("utf-8", { fatal: true });
  const blocks: Block[] = [],
    tools: Tool[] = [];
  const byId = new Map<string, Tool>();
  let latest: Tool | undefined;
  const usage: DevinUsage = { input: 0, output: 0, cached: 0, written: 0 };
  const encoder = new TextEncoder();
  let controller: TransformStreamDefaultController<Uint8Array>;
  const pendingEvents: Uint8Array[] = [];
  let pendingSize = 0,
    thinkingClosed = false;
  const event = (value: Record<string, unknown>) => {
    const encoded = encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    // SDK 只在当前块为 thinking 时接受签名；保留迟到签名前的工具/文本事件顺序。
    if (
      thinkingIndex !== undefined &&
      !thinkingClosed &&
      value.index !== thinkingIndex &&
      value.type !== "message_start"
    ) {
      pendingSize += encoded.byteLength;
      if (pendingSize > DEVIN_MAX_DECOMPRESSED_FRAME)
        devinFailure("pending content exceeds the limit");
      pendingEvents.push(encoded);
    } else controller.enqueue(encoded);
  };
  const start = (block: Block): number => {
    const index = blocks.length;
    blocks.push(block);
    event({ type: "content_block_start", index, content_block: { ...block } });
    return index;
  };
  const delta = (index: number, value: Block) =>
    event({ type: "content_block_delta", index, delta: value });
  const closeText = () => {
    if (textIndex !== undefined) {
      event({ type: "content_block_stop", index: textIndex });
      textIndex = undefined;
    }
  };
  const decode = (decoder: TextDecoder, bytes?: Uint8Array): string => {
    try {
      return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
    } catch {
      return devinFailure("returned invalid UTF-8 content");
    }
  };
  const text = (value: string) => {
    if (!value) return;
    textIndex ??= start({ type: "text", text: "" });
    blocks[textIndex].text = String(blocks[textIndex].text) + value;
    delta(textIndex, { type: "text_delta", text: value });
  };
  const thought = (value: string) => {
    if (!value) return;
    thinkingIndex ??= start({ type: "thinking", thinking: "", signature: "" });
    blocks[thinkingIndex].thinking = String(blocks[thinkingIndex].thinking) + value;
    delta(thinkingIndex, { type: "thinking_delta", thinking: value });
  };
  const toolDelta = (value: { id: string; name: string; arguments: Buffer }) => {
    closeText();
    let tool = value.id ? byId.get(value.id) : latest;
    if (!tool && value.id && latest && !latest.id) tool = latest;
    if (!tool) {
      if (tools.length >= MAX_TOOLS) devinFailure("exceeded the tool call limit");
      tool = {
        id: value.id,
        name: value.name,
        args: "",
        index: blocks.length,
        started: false,
        decoder: new TextDecoder("utf-8", { fatal: true }),
      };
      blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: {} });
      tools.push(tool);
    }
    if (
      (tool.id && value.id && tool.id !== value.id) ||
      (tool.name && value.name && tool.name !== value.name)
    )
      devinFailure("changed a tool call identity");
    if (value.id) {
      tool.id = value.id;
      byId.set(value.id, tool);
    }
    if (value.name) tool.name = value.name;
    latest = tool;
    const part = decode(tool.decoder, value.arguments);
    tool.args += part;
    if (tool.args.length > DEVIN_MAX_VALUE) devinFailure("tool arguments exceed the limit");
    if (!tool.started && tool.id && tool.name) {
      blocks[tool.index] = { type: "tool_use", id: tool.id, name: tool.name, input: {} };
      event({ type: "content_block_start", index: tool.index, content_block: blocks[tool.index] });
      tool.started = true;
      if (tool.args) delta(tool.index, { type: "input_json_delta", partial_json: tool.args });
    } else if (tool.started && part)
      delta(tool.index, { type: "input_json_delta", partial_json: part });
  };
  const finish = (payload: Buffer) => {
    let trailer: Record<string, unknown> | undefined;
    try {
      // Connect 允许空 EOS payload；缺少 EOS 帧仍由 framing owner 拒绝。
      trailer = devinRecord(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload).trim() || "{}"),
      );
    } catch {
      devinFailure("returned an invalid EOS trailer");
    }
    if (!trailer || (trailer.error !== undefined && trailer.error !== null))
      devinFailure("upstream rejected the Connect stream");
    if (!started || ![2, 4, 10].includes(stop))
      devinFailure("did not return a successful stop reason");
    if ((stop === 10 && !tools.length) || (tools.length && stop !== 10))
      devinFailure("returned an inconsistent tool stop reason");
    text(decode(textDecoder));
    thought(decode(thoughtDecoder));
    if (signature.length) {
      thinkingIndex ??= start({ type: "thinking", thinking: "", signature: "" });
      const value = packDevinSignature(signature, signatureType);
      blocks[thinkingIndex].signature = value;
      delta(thinkingIndex, { type: "signature_delta", signature: value });
    }
    if (thinkingIndex !== undefined) event({ type: "content_block_stop", index: thinkingIndex });
    thinkingClosed = true;
    for (const event of pendingEvents) controller.enqueue(event);
    pendingEvents.length = 0;
    pendingSize = 0;
    closeText();
    for (const tool of tools) {
      const rest = decode(tool.decoder);
      tool.args += rest;
      if (rest && tool.started) delta(tool.index, { type: "input_json_delta", partial_json: rest });
      if (!tool.started) devinFailure("returned an incomplete tool identity");
      let input: unknown;
      try {
        input = JSON.parse(tool.args || "{}");
      } catch {
        devinFailure("returned invalid tool JSON");
      }
      if (!devinRecord(input)) devinFailure("returned non-object tool JSON");
      blocks[tool.index].input = input;
      event({ type: "content_block_stop", index: tool.index });
    }
    if (!blocks.length) devinFailure("returned no assistant content");
    const stopReason = stop === 10 ? "tool_use" : "end_turn";
    const tokens = {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cached,
      cache_creation_input_tokens: usage.written,
    };
    event({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: tokens,
    });
    const message = {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: tokens,
    };
    completed(message);
    event({ type: "message_stop" });
    terminal = true;
    buffer = Buffer.alloc(0);
    controller.terminate();
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    start(value) {
      controller = value;
    },
    async transform(chunk) {
      if (terminal) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const flag = buffer[0],
          size = buffer.readUInt32BE(1);
        if (flag > 3 || size > DEVIN_MAX_FRAME) devinFailure("returned an invalid frame header");
        if (buffer.length < size + 5) break;
        let payload = buffer.subarray(5, size + 5);
        buffer = buffer.subarray(size + 5);
        if (flag & 1) {
          try {
            payload = await decompress(payload, { maxOutputLength: DEVIN_MAX_DECOMPRESSED_FRAME });
          } catch {
            devinFailure("returned invalid or oversized gzip data");
          }
        }
        if (flag & 2) {
          finish(payload);
          return;
        }
        const frame = decodeDevinFrame(payload);
        if (!started) {
          messageId = frame.id || randomUUID();
          started = true;
          event({
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
        }
        if (frame.stop) stop = frame.stop;
        Object.assign(usage, frame.usage);
        if (signature.length + frame.signature.length > DEVIN_MAX_VALUE)
          devinFailure("signature exceeds the limit");
        if (frame.signatureType && signatureType && frame.signatureType !== signatureType)
          devinFailure("changed the thinking signature type");
        if (frame.signatureType) signatureType = frame.signatureType;
        if (frame.signature.length) signature = Buffer.concat([signature, frame.signature]);
        thought(decode(thoughtDecoder, frame.thinking));
        for (const tool of frame.tools) toolDelta(tool);
        text(decode(textDecoder, frame.text));
      }
    },
    flush() {
      if (!terminal)
        devinFailure(
          buffer.length ? "returned a truncated Connect frame" : "ended before the EOS trailer",
        );
    },
  });
}
