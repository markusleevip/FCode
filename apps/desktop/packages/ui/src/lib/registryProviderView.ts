import { getNativeProviderPresentation } from "@fcode/provider";
import { PROVIDER_OAUTH_SUPPLIERS, type ModelSelectionView } from "@fcode/services";

export function resolveProviderLabel(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return "";
  const safeId = normalizedId.includes("@") ? "" : normalizedId;
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    // 切换提示原先直接用历史 providerName，导致账号邮箱再次出现在聊天记录中。
    // 供应商身份只从 snapshot 的 access 读取；与选择器复用品牌，不改 marker 或路由 ID。
    const access = registryProvider.config.access;
    if (access?.type === "provider-oauth") {
      const presentation = getNativeProviderPresentation(access);
      if (presentation) return presentation.providerName;
      if (access.supplier === "vertex") return "Vertex AI";
      const supplier = PROVIDER_OAUTH_SUPPLIERS.find((item) => item.id === access.supplier);
      if (supplier) return supplier.name;
    }
    const name = registryProvider.providerName?.trim();
    return name && !name.includes("@") ? name : safeId;
  }
  return safeId;
}

export function resolveProviderBaseURL(
  providerId: string | undefined,
  registryView: ModelSelectionView | null,
): string | undefined {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return undefined;
  const registryProvider = registryView?.providers.find(
    (provider) => provider.providerId === normalizedId,
  );
  if (registryProvider) {
    return registryProvider.config.api?.baseUrl?.trim() || undefined;
  }
  return undefined;
}
