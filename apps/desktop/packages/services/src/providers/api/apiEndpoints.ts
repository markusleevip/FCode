import { buildRuntimeFCodeApiUrl, resolveZaiBusinessBaseUrl } from "@fcode/shared";

export const FCODE_CLIENT_SCENES_URL = buildRuntimeFCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
