import type { AgentRuntimeInternal } from "../internal.js";
import type { RunModelTextRequestOptions } from "../types.js";
import { traceContextToLogContext } from "../deps.js";
import { logMediaCapabilityProjection, logMediaBudgetProjection, logModelRequestMediaSummary,
  projectMessagesWithMediaAttachmentPaths, projectMessagesForInputFormat, projectMessagesForMediaBudget } from "./index.js";
import { projectComputerUseScreenshots } from "./computer-use-screenshot-window.js";

/** One shared request assembly path preserves ordinary attachment policy. */
export async function prepareModelRequestMedia(runtime: Pick<AgentRuntimeInternal, "logger" | "artifactStore">,
  options: RunModelTextRequestOptions) {
  const model = options.model;
  const screenshots = projectComputerUseScreenshots(options.messages);
  runtime.logger?.debug("Computer Use request screenshot window", {
    ...traceContextToLogContext(options.traceContext),
    event: "model.request.computer_use_screenshots",
    ...screenshots.diagnostics,
  });
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    screenshots.messages,
    runtime.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(runtime.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(runtime.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(runtime.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  return { projectedOptions, screenshots };
}
