import type { ProviderConfigObject } from "./config/index.js";

/** 展示来自供应商类型，不把账号邮箱当作品牌；兼容历史邮箱命名连接。 */
export function getNativeProviderPresentation(
  access: ProviderConfigObject["access"],
): { providerName: string; logo: NonNullable<ProviderConfigObject["logo"]> } | undefined {
  if (access?.type !== "provider-oauth") return undefined;
  switch (access.supplier) {
    case "codex":
      return { providerName: "Codex", logo: { type: "builtin", key: "codex" } };
    case "claude":
      // Claude 的旧连接仍存有邮箱；与 Codex 复用品牌投影，不改账号或模型路由。
      return { providerName: "Claude", logo: { type: "builtin", key: "anthropic" } };
    case "antigravity":
      return { providerName: "Antigravity", logo: { type: "builtin", key: "antigravity" } };
    case "cline":
      // Cline has no bundled logo asset yet; the UI falls back to its generic icon.
      return { providerName: "Cline", logo: { type: "builtin", key: "cline" } };
    default:
      return undefined;
  }
}
