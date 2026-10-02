import { materializeFCodeBuiltinProviderConfig } from "@fcode/services/node";

declare const __FCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledFCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 FCode Built-in Provider Config。 */
export function readBundledFCodeBuiltinProviderConfig(): string {
  if (typeof __FCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 FCode Built-in Provider Config");
  }
  return __FCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 FCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledFCodeBuiltinProviderConfig(
  options: MaterializeBundledFCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeFCodeBuiltinProviderConfig(options);
}
