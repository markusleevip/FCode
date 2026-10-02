// Per-request Gemini SSE owner adapted from CLIProxyAPI Antigravity (MIT).
import { randomUUID } from "node:crypto";
import {
  geminiRecord,
  geminiFailure,
  type NativeRecord,
  type GeminiNativeSupplier,
} from "./gemini-native-tools.js";
import { packGeminiNativeSignature } from "./gemini-native-history.js";
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const MAX_FRAME_CHARS = 8 * 1024 * 1024,
  MAX_RESPONSE_CHARS = 64 * 1024 * 1024,
  MAX_TOOLS = 128;
function token(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    geminiFailure("usage is invalid");
  return value;
}
export function createGeminiNativeStream(options: {
  supplier: GeminiNativeSupplier;
  model: string;
  original(name: string): string;
  onFinal?(message: NativeRecord): void;
}) {
  const packSignature = (value: Parameters<typeof packGeminiNativeSignature>[0]) =>
    packGeminiNativeSignature(value, options.supplier);
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    encoder = new TextEncoder();
  let pending = "",
    started = false,
    finished = false,
    reason = false,
    hasUsage = false,
    responseId: string | undefined;
  let usage: NativeRecord = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const content: NativeRecord[] = [],
    toolIds = new Set<string>();
  let active: { index: number; kind: "text" | "thinking"; block: NativeRecord } | undefined;
  let responseChars = 0;
  let traceId: string | undefined;
  let pendingTool: { call: NativeRecord; signed?: string } | undefined;
  const messageId = `${options.supplier}_` + randomUUID();
  function event(controller: TransformStreamDefaultController<Uint8Array>, data: NativeRecord) {
    controller.enqueue(encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`));
  }
  function close(controller: TransformStreamDefaultController<Uint8Array>) {
    if (!active) return;
    event(controller, { type: "content_block_stop", index: active.index });
    active = undefined;
  }
  function reserve(size: number) {
    responseChars += size;
    if (responseChars > MAX_RESPONSE_CHARS) geminiFailure("response exceeds its limit");
  }
  function carrier(controller: TransformStreamDefaultController<Uint8Array>, packed: string) {
    reserve(packed.length);
    const index = content.length;
    content.push({ type: "thinking", thinking: "", signature: packed });
    event(controller, {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
    event(controller, {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: packed },
    });
    event(controller, { type: "content_block_stop", index });
  }
  function text(
    controller: TransformStreamDefaultController<Uint8Array>,
    value: string,
    thought = false,
    signed?: string,
  ) {
    const kind = thought ? "thinking" : "text";
    if (active?.kind !== kind) {
      close(controller);
      const block =
        kind === "thinking"
          ? { type: kind, thinking: "", signature: "" }
          : { type: kind, text: "" };
      active = { index: content.length, kind, block };
      content.push(block);
      event(controller, {
        type: "content_block_start",
        index: active.index,
        content_block: structuredClone(block),
      });
    }
    const current = active!;
    const key = thought ? "thinking" : "text";
    current.block[key] = String(current.block[key]) + value;
    reserve(value.length);
    if (value)
      event(controller, {
        type: "content_block_delta",
        index: current.index,
        delta: thought
          ? { type: "thinking_delta", thinking: value }
          : { type: "text_delta", text: value },
      });
    if (signed) {
      if (!thought) {
        const packed = packSignature({
          model: options.model,
          signature: signed,
          target: "text",
          text: String(current.block.text),
        });
        close(controller);
        carrier(controller, packed);
        return;
      }
      const packed = packSignature({
        model: options.model,
        signature: signed,
        target: "thinking",
      });
      reserve(packed.length);
      current.block.signature = packed;
      event(controller, {
        type: "content_block_delta",
        index: current.index,
        delta: { type: "signature_delta", signature: packed },
      });
      close(controller);
    }
  }
  function tool(
    controller: TransformStreamDefaultController<Uint8Array>,
    call: NativeRecord,
    signed?: string,
  ) {
    if (typeof call.name !== "string" || !geminiRecord(call.args))
      geminiFailure("function call is invalid");
    const name = options.original(call.name);
    const id =
      typeof call.id === "string" && call.id
        ? call.id
        : `${options.supplier}_call_${randomUUID().replaceAll("-", "")}`;
    if (toolIds.has(id) || toolIds.size >= MAX_TOOLS)
      geminiFailure("function calls are duplicate or exceed their limit");
    toolIds.add(id);
    const args = JSON.stringify(call.args);
    if (args.length > MAX_FRAME_CHARS) geminiFailure("function arguments exceed their limit");
    reserve(args.length);
    close(controller);
    if (signed) {
      const packed = packSignature({
        model: options.model,
        signature: signed,
        target: "function",
        callId: id,
      });
      // Messages SDK 不能在 tool_use 保存 Gemini part 签名，使用紧邻的私有 reasoning carrier 回放。
      carrier(controller, packed);
    }
    const index = content.length;
    content.push({ type: "tool_use", id, name, input: call.args });
    event(controller, {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    event(controller, {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: args },
    });
    event(controller, { type: "content_block_stop", index });
  }
  function flushTool(controller: TransformStreamDefaultController<Uint8Array>) {
    if (pendingTool) {
      const current = pendingTool;
      pendingTool = undefined;
      tool(controller, current.call, current.signed);
    }
  }
  function finish(controller: TransformStreamDefaultController<Uint8Array>) {
    if (!reason || !hasUsage) return;
    flushTool(controller);
    if (
      !content.some(
        (part) =>
          part.type === "tool_use" ||
          (part.type === "text" && part.text) ||
          (part.type === "thinking" && part.thinking),
      )
    )
      geminiFailure("completed without content");
    close(controller);
    const stop_reason = toolIds.size ? "tool_use" : "end_turn";
    const message = {
      id: messageId,
      type: "message",
      role: "assistant",
      model: options.model,
      content,
      stop_reason,
      stop_sequence: null,
      usage,
    };
    options.onFinal?.(message);
    event(controller, {
      type: "message_delta",
      delta: { stop_reason, stop_sequence: null },
      usage,
    });
    event(controller, { type: "message_stop" });
    finished = true;
    pending = "";
    controller.terminate();
  }
  function frame(raw: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const data = raw
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let envelope: NativeRecord | undefined;
    try {
      envelope = geminiRecord(JSON.parse(data));
    } catch {
      geminiFailure("stream contains invalid JSON");
    }
    const response = options.supplier === "vertex" ? envelope : geminiRecord(envelope?.response);
    if (!envelope || envelope.error || response?.error) geminiFailure("upstream reported failure");
    if (!response) geminiFailure("response envelope is missing");
    if (typeof envelope.traceId === "string") {
      if (traceId && traceId !== envelope.traceId) geminiFailure("response trace identity changed");
      traceId = envelope.traceId;
    }
    if (geminiRecord(response.promptFeedback)?.blockReason) geminiFailure("prompt was blocked");
    if (typeof response.responseId === "string") {
      if (responseId && responseId !== response.responseId)
        geminiFailure("response identity changed");
      responseId = response.responseId;
    }
    if (!started) {
      event(controller, {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      });
      started = true;
    }
    const candidates = response.candidates;
    if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 1))
      geminiFailure("candidate selection is invalid");
    const candidate = Array.isArray(candidates) ? geminiRecord(candidates[0]) : undefined;
    const parts = geminiRecord(candidate?.content)?.parts;
    if (parts !== undefined && !Array.isArray(parts)) geminiFailure("content parts are invalid");
    for (const value of (parts ?? []) as unknown[]) {
      const part = geminiRecord(value);
      if (!part) geminiFailure("content part is invalid");
      const signed = part.thoughtSignature;
      if (signed !== undefined && typeof signed !== "string") geminiFailure("signature is invalid");
      if (part.functionCall) {
        if (reason) geminiFailure("function call arrived after finish reason");
        flushTool(controller);
        close(controller);
        pendingTool = {
          call: geminiRecord(part.functionCall) ?? geminiFailure("function call is invalid"),
          signed: signed as string | undefined,
        };
      } else if (typeof part.text === "string") {
        if (pendingTool && !part.text && signed) {
          pendingTool.signed = signed as string;
          flushTool(controller);
          continue;
        }
        flushTool(controller);
        if (reason && part.text) geminiFailure("content arrived after finish reason");
        if (part.text || signed)
          text(
            controller,
            part.text,
            part.thought === true || (!!signed && active?.kind === "thinking"),
            signed as string | undefined,
          );
      } else if (signed && pendingTool) {
        pendingTool.signed = signed as string;
        flushTool(controller);
      } else if (signed && active)
        text(controller, "", active.kind === "thinking", signed as string);
      else geminiFailure("content part is unsupported");
    }
    if (candidate?.finishReason !== undefined) {
      if (candidate.finishReason !== "STOP")
        geminiFailure("upstream did not complete successfully");
      reason = true;
    }
    if (response.usageMetadata !== undefined) {
      const value = geminiRecord(response.usageMetadata);
      if (!value) geminiFailure("usage is invalid");
      const prompt = token(value.promptTokenCount),
        cached = token(value.cachedContentTokenCount);
      if (cached > prompt) geminiFailure("cached usage exceeds prompt usage");
      usage = {
        input_tokens: prompt - cached,
        cache_read_input_tokens: cached,
        output_tokens: token(value.candidatesTokenCount) + token(value.thoughtsTokenCount),
      };
      if (!Number.isSafeInteger(usage.output_tokens)) geminiFailure("usage overflows");
      hasUsage = true;
    }
    finish(controller);
  }
  function drain(controller: TransformStreamDefaultController<Uint8Array>, final = false) {
    while (!finished) {
      const match = FRAME_SEPARATOR.exec(pending);
      if (!match) break;
      if (match.index > MAX_FRAME_CHARS) geminiFailure("stream frame exceeds its limit");
      const raw = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      frame(raw, controller);
    }
    if (pending.length > MAX_FRAME_CHARS) geminiFailure("stream frame exceeds its limit");
    if (final && !finished && pending.trim()) {
      frame(pending, controller);
      pending = "";
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      drain(controller);
    },
    flush(controller) {
      pending += decoder.decode();
      drain(controller, true);
      if (!finished) geminiFailure("disconnected before successful finish and usage");
    },
  });
}
