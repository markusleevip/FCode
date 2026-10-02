// Native stream terminal handling adapted from CLIProxyAPI (MIT).
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import { asResponsesRecord, responsesSupplierLabel } from "./responses-native-profile.js";

const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
type JsonRecord = Record<string, unknown>;

export function validateResponsesCompleted(value: unknown, supplier = "codex"): JsonRecord {
  const label = responsesSupplierLabel(supplier);
  const response = asResponsesRecord(value);
  if (
    !response ||
    response.error ||
    response.status !== "completed" ||
    !Array.isArray(response.output)
  ) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelResponse,
      `${label} did not return a completed response`,
    );
  }
  return response;
}

export function createResponsesStreamTransform(
  onCompleted: (response: JsonRecord) => void,
  supplier = "codex",
  normalizeEvents: (event: JsonRecord) => readonly JsonRecord[] = (event) => [event],
): TransformStream<Uint8Array, Uint8Array> {
  const label = responsesSupplierLabel(supplier);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const items = new Map<number, JsonRecord>();
  const fallback: JsonRecord[] = [];
  let pending = "";
  let completed = false;
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
    if (data === "[DONE]") {
      if (!completed)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} stream ended without completion`,
        );
      return;
    }
    let event: JsonRecord | undefined;
    try {
      event = asResponsesRecord(JSON.parse(data));
    } catch {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        `${label} stream contains invalid JSON`,
      );
    }
    if (!event)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        `${label} stream contains an invalid event`,
      );
    // 厂商事件过滤只能隐藏内部工具，不能把携带内部 item_id 的错误终态过滤掉。
    if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) {
      accept(event, controller);
      return;
    }
    for (const normalized of normalizeEvents(event)) {
      accept(normalized, controller);
      if (completed) break;
    }
  }
  function accept(
    event: JsonRecord,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) {
      throw new ModelProtocolError(
        ModelErrorCode.ModelRequestFailed,
        `${label} request did not complete`,
        { supplier, terminal: event.type },
      );
    }
    if (event.type === "response.output_item.done") {
      const item = asResponsesRecord(event.item);
      if (item) {
        if (Number.isSafeInteger(event.output_index) && Number(event.output_index) >= 0)
          items.set(Number(event.output_index), item);
        else fallback.push(item);
      }
    }
    if (event.type === "response.completed") {
      const raw = asResponsesRecord(event.response);
      if (!raw)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} completion is missing its response`,
        );
      const collected = [...items.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item)
        .concat(fallback);
      // 缺失的 output 只能由已完成的条目重建，不能把损坏的终态伪装成空回复成功。
      if (!Array.isArray(raw.output) && (raw.output !== undefined || collected.length === 0)) {
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} completion is missing valid output`,
        );
      }
      // 上游可能只在 output_item.done 中返回完整工具/文本；终态不允许把这些内容丢掉。
      const output =
        Array.isArray(raw.output) && raw.output.length
          ? raw.output.map((value, index) => {
              const item = asResponsesRecord(value);
              const id = items.get(index)?.id;
              return item && !item.id && typeof id === "string" ? { ...item, id } : value;
            })
          : collected;
      const response = validateResponsesCompleted({ ...raw, output }, supplier);
      onCompleted(response);
      completed = true;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, response })}\n\n`));
      // completed 是请求成功终态，继续等 keep-alive 会让标题和压缩永远挂起。
      controller.terminate();
      return;
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  function flushFrames(
    controller: TransformStreamDefaultController<Uint8Array>,
    final = false,
  ): void {
    while (!completed) {
      const match = FRAME_SEPARATOR.exec(pending);
      if (!match) break;
      if (match.index > MAX_FRAME_CHARS)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} stream frame exceeds its limit`,
        );
      const text = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      frame(text, controller);
    }
    if (completed) {
      pending = "";
      return;
    }
    if (pending.length > MAX_FRAME_CHARS)
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelResponse,
        `${label} stream frame exceeds its limit`,
      );
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
      if (!completed)
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelResponse,
          `${label} stream disconnected before completion`,
        );
    },
  });
}
