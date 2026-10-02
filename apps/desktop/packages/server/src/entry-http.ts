import { normalizeLegacyFCodeEnv } from "@fcode/shared/branding-compatibility";
const startupEnv = normalizeLegacyFCodeEnv(process.env);
import { createLocalServices, getAppConfigDir } from "@fcode/services/node";
import {
  materializeBundledFCodeBuiltinProviderConfig,
  readBundledFCodeBuiltinProviderConfig,
} from "./bundledFCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const fcodeBuiltinProviderConfigFilePath = await materializeBundledFCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledFCodeBuiltinProviderConfig(),
  });
  const port = Number(startupEnv["PORT"]) || 3030;
  const host = startupEnv["FCODE_SERVER_HOST"]?.trim() || startupEnv["HOST"]?.trim() || undefined;
  const staticRoot = startupEnv["FCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = startupEnv["FCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    fcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[fcode-server:http] startup failed", error);
  process.exitCode = 1;
});
