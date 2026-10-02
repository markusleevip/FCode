import {
  buildBigModelApiUrl,
  BUILTIN_MODEL_PROVIDER_IDS,
  createUuid,
  type OAuthProviderId,
  FCODE_ENV,
  type BuiltinModelProviderId,
  type UsageQuotaLimit,
  type UsageEntitlementSubscriptionDetail,
  type UsageEntitlementSnapshot,
} from "@fcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

export function filterCreatableProviderTemplates<T extends { templateId: string }>(
  templates: readonly T[],
): T[] {
  const hidden = new Set([
    "fcode",
    "zai-api",
    "zai-standard-api",
    "bigmodel-api",
    "bigmodel-standard-api",
  ]);
  return templates.filter((template) => !hidden.has(template.templateId));
}

export function resolveFCodeInitialNodeKey(items: readonly ModelProviderNavItem[]): string | null {
  return (
    items.find(
      (item) => item.type === "preset" && item.presetId === BUILTIN_MODEL_PROVIDER_IDS.fcode,
    )?.key ?? null
  );
}

export function generateId(): string {
  return createUuid();
}

export const PRESET_SUBSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
export const BIGMODEL_REGISTRATION_URL = buildBigModelApiUrl({ FCODE_ENV }, "/login");

export interface PresetProviderSpec {
  id: BuiltinModelProviderId;
  displayName: string;
  oauthProviderId?: OAuthProviderId;
}

export const PRESET_PROVIDER_SPECS: PresetProviderSpec[] = [
  {
    // FCode 使用用户自己的 Key，不复用官方套餐或登录身份。
    id: BUILTIN_MODEL_PROVIDER_IDS.fcode,
    displayName: "FCode",
  },
];

export const PRESET_PROVIDER_SPEC_BY_ID = new Map<BuiltinModelProviderId, PresetProviderSpec>(
  PRESET_PROVIDER_SPECS.map((item) => [item.id, item]),
);

export type CodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

export type CodingPlanStatus =
  | "disconnected"
  | "checking"
  | "notPurchased"
  | "purchased"
  | "unavailable"
  | "unsupported";

export type TeamPlanAvailabilityReason = "not-allocated" | "expired" | "credential-unavailable";

interface CodingPlanProviderSpec {
  id: CodingPlanProviderId;
  oauthProviderId: OAuthProviderId;
  label: string;
  providerName: string;
  purchaseUrl?: string;
}

// 历史个人连接仍由配置视图读取；模型设置不再生成官方套餐入口。
export const CODING_PLAN_PROVIDER_SPECS: CodingPlanProviderSpec[] = [];

export interface CodingPlanEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  if (
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  ) {
    return "Z.ai - Coding Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return "Start Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan) {
    return "Start Plan";
  }

  return getProviderFormLabel(provider);
}

export type ModelProviderNavItem =
  | {
      key: string;
      type: "preset";
      /** 品牌入口图标独立于其历史 Start 导航身份。 */
      logo?: ProviderSettingsFormProvider["config"]["logo"];
      /** 账号组圆点只展示当前具体连接的公共执行结果。 */
      statusProvider?: ProviderSettingsFormProvider | null;
      presetId: BuiltinModelProviderId;
      label: string;
      provider: ProviderSettingsFormProvider | null;
      displayName: string;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay 是否已启用该 Provider。 */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，单独透传给额度卡片。 */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      /** 权益查询明确要求重新登录；文案不参与操作分支判定。 */
      accountLoginRequired?: boolean;
      statusLabelId?: string;
      statusMessage?: string | null;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "teamPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      teamPlanName: string;
      organizationId?: string | null;
      projectId?: string | null;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay 是否已启用该 Provider。 */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，单独透传给额度卡片。 */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      statusLabelId?: string;
      statusMessage?: string | null;
      /** Team 状态的业务原因。交互不得再从 i18n 文案反推。 */
      availabilityReason?: TeamPlanAvailabilityReason;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlanLoading";
      label: string;
      providerName: string;
      oauthProviderId?: OAuthProviderId;
    }
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
