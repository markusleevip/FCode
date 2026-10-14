import type { Logger, ToolCallId, TraceContext } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;
function hasToolInputLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r");
}

export function createModelStreamToolBuffer(logger: Logger | undefined, traceContext: TraceContext,
  emit: (id: ToolCallId, delta: string) => Promise<void>) {
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await emit(toolCallId, delta);
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      await flushToolInputDelta(toolCallId);
    }
  };
  return { toolInputDeltaBuffers, flushToolInputDelta, flushAllToolInputDeltas, appendToolInputDelta };
}
