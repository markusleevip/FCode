import {
  isFCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  fcodeProviderAccountAccessSchema,
  type FCodeProviderAccountAccess,
  type FCodeProvider,
} from "@fcode/shared";
import type { ModelSelectionView } from "@fcode/services";
import { getNativeProviderPresentation } from "@fcode/provider";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/fcodeCustomModelValue.js";
import { FREE_MODEL_BADGE_LABEL, isFreeModel } from "@/lib/modelFreeBadge.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: FCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（FCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isFCodeAgentProvider(selectedProvider);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: FCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  return view.providers.flatMap((provider) => {
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = fcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const nativePresentation = getNativeProviderPresentation(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label:
          nativePresentation?.providerName ??
          (accountPresentation?.label || provider.providerName?.trim() || provider.providerId),
        ...(nativePresentation
          ? { providerName: nativePresentation.providerName, logo: nativePresentation.logo }
          : {}),
        ...(accountPresentation?.labelBadge ? { labelBadge: accountPresentation.labelBadge } : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: freeModelsFirst(provider.models).map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(isFreeModel(modelId) ? { badgeLabel: FREE_MODEL_BADGE_LABEL } : {}),
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
}

/** Free models lead the picker; both partitions keep their configured order. */
function freeModelsFirst<T extends { readonly modelId: string }>(models: readonly T[]): T[] {
  return [
    ...models.filter((model) => isFreeModel(model.modelId)),
    ...models.filter((model) => !isFreeModel(model.modelId)),
  ];
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: FCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
