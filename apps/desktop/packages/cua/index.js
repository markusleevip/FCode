const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function createComputerUseRuntime(options) {
  if (options?.brokerSocketPath && options?.brokerToken) return createComputerUseRuntimeClient(options);
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
import { createComputerUseRuntimeClient } from "./runtime-client-node.js";
