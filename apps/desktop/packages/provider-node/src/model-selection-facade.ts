import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@fcode/provider";
import {
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@fcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // Start 按真实 ID 解析；不能参与付费连接唯一性判断或被映射到付费额度。
      if (isStartPlanModelProviderId(providerId)) return "ordinary";
      // 内置 API 预设不代表账号套餐；只有官方 Coding Plan 才能按当前账号重映射。
      if (isCodingPlanModelProviderId(providerId)) return "account-plan";
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
