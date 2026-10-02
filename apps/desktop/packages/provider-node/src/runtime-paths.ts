export const FCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "FCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const FCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "FCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const FCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "FCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly fcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [FCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.fcodeBuiltinFilePath,
    [FCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const fcodeBuiltinFilePath = env[FCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[FCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!fcodeBuiltinFilePath && !personalFilePath) return null;
  if (!fcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("FCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ fcodeBuiltinFilePath, personalFilePath });
}
