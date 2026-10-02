// 旧键只用于兼容读取；新键（包括显式空值）拥有优先级，不重写用户配置。
export const LEGACY_BRAND = "zcode";
export const LEGACY_ENV_PREFIX = "ZCODE_";
export const PRODUCT_DIRECTORY = ".fcode";
export const LEGACY_PRODUCT_DIRECTORY = ".zcode";
export const LEGACY_PLUGIN_DIRECTORY = ".zcode-plugin";

export function normalizeLegacyFCodeEnv<T extends Record<string, string | undefined>>(env: T): T {
  const normalized = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith(LEGACY_ENV_PREFIX)) continue;
    const primary = `FCODE_${key.slice(LEGACY_ENV_PREFIX.length)}`;
    const primaryKey = Object.keys(env).find((candidate) => candidate.toUpperCase() === primary);
    if (!primaryKey) (normalized as Record<string, string | undefined>)[primary] = value;
    delete normalized[key];
  }
  return normalized;
}

export function readFCodeStorageItem(
  storage: Pick<Storage, "getItem">,
  key: string,
): string | null {
  const primary = storage.getItem(key);
  if (primary !== null) return primary;
  const legacyKey = key.replace(/fcode/gi, (token) =>
    token === token.toUpperCase() ? LEGACY_BRAND.toUpperCase() : LEGACY_BRAND,
  );
  return legacyKey === key ? null : storage.getItem(legacyKey);
}

export function normalizeLegacyFCodePluginId(id: string): string {
  const suffix = `@${LEGACY_BRAND}-plugins-official`;
  if (!id.endsWith(suffix)) return id;
  const name = id.slice(0, -suffix.length);
  const canonicalName =
    name === `${LEGACY_BRAND}-cua`
      ? "computer-use"
      : name === `${LEGACY_BRAND}-guide`
        ? "fcode-guide"
        : name;
  return `${canonicalName}@fcode-plugins-official`;
}

/** 只迁移 AppSettings 自有字段；不改写连接、端点值或用户 Provider 身份。 */
export function normalizeLegacyFCodeSettings(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  for (const primary of ["fcodeInteractionBehavior", "fcodeEndpointOrigin"]) {
    const legacy = primary.replace("fcode", LEGACY_BRAND);
    if (!(primary in result) && legacy in result) result[primary] = result[legacy];
    delete result[legacy];
  }
  return result;
}

/** 只映射旧产品自有枚举，不处理 Provider id、URL、凭据或其它用户值。 */
export function normalizeLegacyFCodeAgentId(value: string): string {
  return value === LEGACY_BRAND ? "fcode" : value;
}
