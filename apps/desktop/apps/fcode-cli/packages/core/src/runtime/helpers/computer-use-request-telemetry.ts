import type { Logger, ModelUsage, TraceContext } from "@fcode/contracts";
import { traceContextToLogContext } from "@fcode/contracts";

/** Timings omit unavailable values and never contain request content or image bytes. */
export function createComputerUseRequestTelemetry(logger: Logger | undefined, trace: TraceContext,
  captures: number) {
  const started = performance.now();
  let firstOutputMs: number | undefined;
  return {
    output() { firstOutputMs ??= performance.now() - started; },
    finish(usage: ModelUsage, status: "completed" | "failed" = "completed") {
      if (!captures) return;
      logger?.info("Computer Use model request timing", {
        ...traceContextToLogContext(trace), event: "model.response.computer_use_timing", status,
        durationMs: performance.now() - started,
        ...(firstOutputMs !== undefined ? { firstOutputMs } : {}),
        capturedScreenshots: captures,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      });
    },
  };
}
