import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { FCodeProvider } from "./fcode-task-types-core.js";

export const FCODE_AGENT_PROVIDER = "glm" satisfies FCodeProvider;
export const FCODE_AGENT_PROVIDER_LABEL = "FCode Agent";
export const FCODE_COMMAND_AGENT_SOURCE = "fcodeAgent" satisfies CommandAgentSource;

export const fcodeAgentProviderSchema = z.literal(FCODE_AGENT_PROVIDER);

export const FCODE_COMMAND_AGENT_SOURCES = [
  FCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToFCodeAgent(
  _provider?: FCodeProvider | null,
): FCodeProvider {
  return FCODE_AGENT_PROVIDER;
}

export function isFCodeAgentProvider(
  provider: FCodeProvider | null | undefined,
): provider is typeof FCODE_AGENT_PROVIDER {
  return provider === FCODE_AGENT_PROVIDER;
}
