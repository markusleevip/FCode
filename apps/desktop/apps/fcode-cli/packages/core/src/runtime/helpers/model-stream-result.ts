import type { Logger, Model, ModelUsage, TraceContext } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import { buildSuspiciousEmptyDiagnostics, finalizeSuspiciousEmptyModelResult, isContextExceededFinishReason,
  isSuspiciousEmptyModelResult, readRawFinishReason } from "./index.js";
import { isOutputTokenLimitFinishReason } from "../methods/turn-output-token-continuation.js";

/** Preserve reactive compact and suspicious-empty behavior after stream draining. */
export function validateModelStreamResult(logger: Logger | undefined, traceContext: TraceContext,
  model: Pick<Model, "providerId" | "modelId">, input: { finishReason: string; providerMetadata?: Record<string, unknown>;
  usage: ModelUsage; textLength: number; toolCallCount: number }) {
  const { finishReason, providerMetadata, usage, textLength, toolCallCount } = input;
  const rawFinishReason = readRawFinishReason(providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(finishReason, rawFinishReason);
  const contextExceeded =
    toolCallCount === 0 &&
    !outputTokenLimit &&
    isContextExceededFinishReason(finishReason, rawFinishReason);
  if (contextExceeded) {
    logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason,
      module: "core.runtime",
      modelProviderId: model.providerId,
      modelId: model.modelId,
      rawFinishReason,
      textLength: textLength,
      toolCallCount: toolCallCount,
    });
  }

  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(finishReason, textLength, toolCallCount, usage)
  ) {
    logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: model.providerId,
      modelId: model.modelId,
      textLength: textLength,
      toolCallCount: toolCallCount,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason,
        providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason,
      model: model,
      providerMetadata,
      rawFinishReason,
    });
  }
}
