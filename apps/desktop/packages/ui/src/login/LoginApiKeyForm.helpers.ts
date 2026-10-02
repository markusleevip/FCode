import { isApiKeyAccess } from "@fcode/provider";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  type AppSettings,
  type Locale,
} from "@fcode/shared";
import type {
  IProviderSettingsService,
  ISettingService,
  ModelSelectionView,
} from "@fcode/services";
import { encodeCustomModelValue } from "@/lib/fcodeCustomModelValue.js";

export type ApiKeyProviderChoice = "fcode" | "zai" | "bigmodel";

export function resolveLoginApiKeyDefaultProvider(_locale: Locale): ApiKeyProviderChoice {
  // FCode 必须使用自己的稳定预设，不能把显示品牌映射到历史 bigmodel 模板。
  void _locale;
  return "fcode";
}

export function resolveLoginApiKeyTemplateId(
  choice: ApiKeyProviderChoice,
): "fcode" | "zai-api" | "bigmodel-api" {
  return choice === "fcode"
    ? BUILTIN_MODEL_PROVIDER_IDS.fcode
    : BUILTIN_PROVIDER_TEMPLATE_IDS[choice];
}

export function resolveLoginApiKeyProviderLabel(choice: ApiKeyProviderChoice): string {
  return choice === "fcode" ? "FCode" : choice === "zai" ? "Z.ai" : "BigModel";
}

export async function saveLoginApiKeyProvider(
  service: IProviderSettingsService,
  choice: ApiKeyProviderChoice,
  apiKey: string,
): Promise<string> {
  const templateId = resolveLoginApiKeyTemplateId(choice);
  const view = await service.getView();
  const template = view.providerTemplates.find((item) => item.templateId === templateId);
  if (choice === "fcode") {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.fcode;
    const provider = view.providers.find(
      (item) => item.providerId === providerId && item.templateId === templateId,
    );
    if (
      !template ||
      !isApiKeyAccess(template.config.access) ||
      !provider ||
      !isApiKeyAccess(provider.effectiveConfig.access)
    ) {
      throw new Error(
        "FCode preset unavailable. Check model settings or rebuild the desktop application.",
      );
    }
    // 唯一写入路径是公开 overlay 命令：保留本连接个人字段，不复制继承端点/其他连接凭据。
    // 命令负责目录刷新，失败必须穿透表单，不能标记登录成功或创建重复连接。
    await service.savePersonalProviderOverlay(providerId, {
      ...provider.personalConfig,
      access: {
        ...provider.personalConfig?.access,
        type: provider.effectiveConfig.access.type,
        apiKey,
      },
    });
    return providerId;
  }
  if (!template || !isApiKeyAccess(template.config.access)) {
    throw new Error(`Provider template unavailable: ${templateId}`);
  }
  const created = await service.createPersonalProvider({
    templateId,
    initialConfig: { access: { type: template.config.access.type, apiKey } },
  });
  return created.providerId;
}

export function buildLoginApiKeySkipSettings(
  choice: ApiKeyProviderChoice,
  now: number,
): Partial<
  Pick<
    AppSettings,
    "providerFamilyDomain" | "providerFamilyDomainUpdatedAt" | "providerFamilyDomainMigrated"
  >
> {
  // 跳过独立 API 预设不代表选择官方账号域，不能为 FCode 编造 bigmodel。
  if (choice === "fcode") return { providerFamilyDomainMigrated: true };
  return {
    providerFamilyDomain: choice,
    providerFamilyDomainUpdatedAt: now,
    providerFamilyDomainMigrated: true,
  };
}

export async function skipLoginApiKeySetup(
  service: ISettingService,
  choice: ApiKeyProviderChoice,
  onSkipped: () => void | Promise<void>,
): Promise<void> {
  // 入口页和表单复用同一确认路径；跳过不能创建空凭据或触发登录成功。
  await service.update(buildLoginApiKeySkipSettings(choice, Date.now()));
  await onSkipped();
}

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  apiKeyUrl: string | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
