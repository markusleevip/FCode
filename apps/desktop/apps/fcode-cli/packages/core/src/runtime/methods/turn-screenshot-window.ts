import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { projectComputerUseScreenshotEntries } from "../helpers/computer-use-screenshot-window.js";
import { traceContextToLogContext, type TraceContext } from "@fcode/contracts";

/** Prune only after all sibling results are committed; keep each history's current prefix. */
export function pruneTurnComputerUseScreenshots(runtime: Pick<AgentRuntimeInternal, "messageHistory" | "logger">,
  state: TurnRequestState, trace?: TraceContext): void {
  const canonical = projectComputerUseScreenshotEntries(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  const local = projectComputerUseScreenshotEntries(state.entries);
  if (canonical.diagnostics.removed) runtime.messageHistory.replaceMessages(canonical.entries);
  if (local.diagnostics.removed) state.entries = local.entries;
  if (local.diagnostics.capturedBefore) runtime.logger?.debug("Computer Use working screenshot window", {
    ...(trace ? traceContextToLogContext(trace) : {}),
    event: "computer_use.history.screenshot_window", ...local.diagnostics,
  });
}
