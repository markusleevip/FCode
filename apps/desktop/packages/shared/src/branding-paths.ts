import { existsSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_PRODUCT_DIRECTORY, PRODUCT_DIRECTORY } from "./branding-compatibility.js";

/** 旧根已有数据时原地复用；新根存在则优先新根。不移动、合并或覆盖真实用户文件。 */
export function resolveFCodeDirectory(
  baseDirectory: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const primary = join(baseDirectory, PRODUCT_DIRECTORY);
  const legacy = join(baseDirectory, LEGACY_PRODUCT_DIRECTORY);
  return !exists(primary) && exists(legacy) ? legacy : primary;
}

export function resolveFCodePath(baseDirectory: string, ...segments: string[]): string {
  return join(resolveFCodeDirectory(baseDirectory), ...segments);
}

export function resolveFCodePluginManifest(root: string): string {
  const primary = join(root, ".fcode-plugin", "plugin.json");
  const legacy = join(root, ".zcode-plugin", "plugin.json");
  return !existsSync(primary) && existsSync(legacy) ? legacy : primary;
}
