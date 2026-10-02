import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";

const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
type JsonRecord = Record<string, unknown>;

export function messagesRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function invalid(message: string): never {
  throw new ModelProtocolError(ModelErrorCode.InvalidModelResponse, message);
}

function hasReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateNativeMessage(value: unknown): JsonRecord {
  const message = messagesRecord(value);
  if (
    !message ||
    message.error ||
    message.type !== "message" ||
    message.role !== "assistant" ||
    typeof message.id !== "string" ||
    !Array.isArray(message.content) ||
    !hasReason(message.stop_reason)
  ) {
    invalid("Native Messages response is missing its successful terminal");
  }
  return message;
}

/** Per-request terminal owner. SDK alone accepts EOF, so it cannot prove upstream success. */
export function createMessagesStreamTransform(
  normalizeEvent?: (event: JsonRecord) => JsonRecord,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const blocks = new Map<number, boolean>();
  let pending = "";
  let started = false;
  let stopped = false;
  let reason: string | undefined;

  function frame(text: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    const data = text
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) {
      controller.enqueue(encoder.encode(`${text}\n\n`));
      return;
    }
    let event: JsonRecord | undefined;
    try {
      event = messagesRecord(JSON.parse(data));
    } catch {
      invalid("Native Messages stream contains invalid JSON");
    }
    if (!event || typeof event.type !== "string")
      invalid("Native Messages stream contains an invalid event");
    if (event.type === "error" || event.error) {
      throw new ModelProtocolError(
        ModelErrorCode.ModelRequestFailed,
        "Native Messages upstream reported failure",
      );
    }
    if (normalizeEvent) event = normalizeEvent(event);
    if (typeof event.type !== "string") invalid("Native Messages normalized event is invalid");
    if (event.type === "message_start") {
      const message = messagesRecord(event.message);
      if (
        started ||
        !message ||
        message.error ||
        typeof message.id !== "string" ||
        !Array.isArray(message.content)
      )
        invalid("Native Messages stream contains an invalid message start");
      started = true;
      if (hasReason(message.stop_reason)) reason = message.stop_reason;
    } else if (event.type !== "ping") {
      if (!started) invalid("Native Messages event arrived before message start");
      if (event.type.startsWith("content_block_")) {
        const index = event.index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
          invalid("Native Messages content block has an invalid index");
        if (reason) invalid("Native Messages content arrived after stop reason");
        if (event.type === "content_block_start") {
          if (blocks.has(index)) invalid("Native Messages content block started twice");
          blocks.set(index, true);
        } else if (event.type === "content_block_delta" || event.type === "content_block_stop") {
          if (blocks.get(index) !== true) invalid("Native Messages content block is not open");
          if (event.type === "content_block_stop") blocks.set(index, false);
        } else invalid("Native Messages content block event is unsupported");
      } else if (event.type === "message_delta") {
        const delta = messagesRecord(event.delta);
        if (!delta) invalid("Native Messages message delta is invalid");
        if (hasReason(delta.stop_reason)) reason = delta.stop_reason;
      } else if (event.type === "message_stop") {
        if (!reason || [...blocks.values()].some(Boolean))
          invalid("Native Messages stopped before all content and stop reason were complete");
        // message_stop 是唯一成功终态，不能把中途断流当成功或继续等待 keep-alive。
        stopped = true;
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        controller.terminate();
        return;
      } else invalid("Native Messages stream contains an unsupported event");
    }
    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  }

  function flushFrames(
    controller: TransformStreamDefaultController<Uint8Array>,
    final = false,
  ): void {
    while (!stopped) {
      const match = FRAME_SEPARATOR.exec(pending);
      if (!match) break;
      if (match.index > MAX_FRAME_CHARS) invalid("Native Messages stream frame exceeds its limit");
      const text = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      frame(text, controller);
    }
    if (stopped) {
      pending = "";
      return;
    }
    if (pending.length > MAX_FRAME_CHARS) invalid("Native Messages stream frame exceeds its limit");
    if (final && pending.trim()) {
      frame(pending, controller);
      pending = "";
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      flushFrames(controller);
    },
    flush(controller) {
      pending += decoder.decode();
      flushFrames(controller, true);
      if (!stopped) invalid("Native Messages disconnected before message_stop");
    },
  });
}
