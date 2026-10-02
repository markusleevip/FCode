// Reasoning event conversion adapted from CLIProxyAPI (MIT); no proxy history cache.
import { asResponsesRecord as record, type ResponsesRecord } from "./responses-native-profile.js";

const INTERNAL_X_SEARCH_TOOLS = new Set([
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
]);

function reasoningItem(value: unknown): unknown {
  const item = record(value);
  if (item?.type !== "reasoning") return value;
  const part = (value: unknown) => {
    const entry = record(value);
    return entry?.type === "reasoning_text" ? { ...entry, type: "summary_text" } : value;
  };
  const content = Array.isArray(item.content)
    ? item.content.filter((value) => record(value)?.type === "reasoning_text")
    : [];
  const normalized: ResponsesRecord = {
    ...item,
    summary: content.length
      ? content.map(part)
      : Array.isArray(item.summary)
        ? item.summary.map(part)
        : [],
  };
  delete normalized.content;
  return normalized;
}

function normalizeReasoning(event: ResponsesRecord): readonly ResponsesRecord[] {
  const next = { ...event };
  if (next.item) next.item = reasoningItem(next.item);
  const response = record(next.response);
  if (response && Array.isArray(response.output))
    next.response = { ...response, output: response.output.map(reasoningItem) };
  const part = record(next.part);
  const reasoningText =
    next.type === "response.reasoning_text.delta" || next.type === "response.reasoning_text.done";
  const reasoningPart =
    (next.type === "response.content_part.added" || next.type === "response.content_part.done") &&
    part?.type === "reasoning_text";
  if (!reasoningText && !reasoningPart) return [next];
  next.summary_index ??= next.content_index ?? 0;
  delete next.content_index;
  if (next.type === "response.reasoning_text.delta")
    next.type = "response.reasoning_summary_text.delta";
  else if (next.type === "response.reasoning_text.done") {
    const textDone = { ...next, type: "response.reasoning_summary_text.done" };
    next.type = "response.reasoning_summary_part.done";
    next.part = { type: "summary_text", text: next.text ?? "" };
    delete next.text;
    return [textDone, next];
  } else {
    next.type =
      next.type === "response.content_part.added"
        ? "response.reasoning_summary_part.added"
        : "response.reasoning_summary_part.done";
    next.part = { ...part, type: "summary_text" };
  }
  return [next];
}

/** Filter hosted X Search traces only when configured; declared client tools retain ownership. */
export function createXaiEventNormalizer(
  body: ResponsesRecord,
): (event: ResponsesRecord) => readonly ResponsesRecord[] {
  const tools = Array.isArray(body.tools)
    ? body.tools.map(record).filter((value) => value !== undefined)
    : [];
  const hosted = tools.some((tool) => tool.type === "x_search");
  const clientNames = new Set(
    tools
      .filter((tool) => tool.type === "function" || tool.type === "custom")
      .map((tool) => tool.name),
  );
  const droppedIndices = new Set<number>();
  const droppedIds = new Set<string>();
  const internal = (value: unknown) => {
    const item = record(value);
    return (
      hosted &&
      item?.type === "function_call" &&
      typeof item.name === "string" &&
      INTERNAL_X_SEARCH_TOOLS.has(item.name) &&
      !clientNames.has(item.name)
    );
  };
  return (event) => {
    if (internal(event.item)) {
      if (typeof event.output_index === "number") droppedIndices.add(event.output_index);
      const id = record(event.item)?.id;
      if (typeof id === "string") droppedIds.add(id);
      return [];
    }
    if (
      (typeof event.output_index === "number" && droppedIndices.has(event.output_index)) ||
      (typeof event.item_id === "string" && droppedIds.has(event.item_id))
    )
      return [];
    const next = { ...event };
    if (typeof next.output_index === "number") {
      const index = next.output_index;
      next.output_index = index - [...droppedIndices].filter((value) => value < index).length;
    }
    const response = record(next.response);
    if (response && Array.isArray(response.output))
      next.response = { ...response, output: response.output.filter((item) => !internal(item)) };
    return normalizeReasoning(next);
  };
}
