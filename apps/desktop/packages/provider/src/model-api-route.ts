import { ProviderApiConfig, ProviderConfig } from "./config/index.js";

const FCODE_PROVIDER_ID = "fcode";

/** 只解释 FCode 的内置模型路由；不修改供应商配置或其他任务的已绑定模型。 */
export function resolveProviderConfigForModel(
  providerId: string,
  modelId: string,
  config: ProviderConfig,
): ProviderConfig {
  if (providerId !== FCODE_PROVIDER_ID || config.access?.type !== "api-key") return config;
  const route = config.api?.modelRoutes?.find((candidate) =>
    new RegExp(`^(?:${candidate.modelMatch})$`, "i").test(modelId),
  );
  if (!route) return config;
  // Bug 原因：混合目录中的 Claude 曾沿用 FCode 默认 OpenAI codec，导致 thinking 参数被拒绝。
  // 能力解析和 SDK 绑定共用这条纯解析路径；API Key 和自定义 headers 继续来自同一配置。
  return config.overlay(
    new ProviderConfig({
      api: new ProviderApiConfig({ type: route.type, baseUrl: route.baseUrl }),
    }),
  );
}
