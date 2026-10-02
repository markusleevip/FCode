import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@fcode/contracts";
import { activateDirectoryAtomically, recoverAtomicTargetSync, type AtomicDirectoryActivation } from "./atomic-directory.js";
import { resolveInside } from "./helpers.js";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export function writeBundledOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function writeCdnOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function loadBundledOfficialPluginRootsSync(storageRoot: string): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", FCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

function rebuildOfficialMarketplaceSync(storageRoot: string): Record<string, unknown> {
  const bundledPartition = readBundledPartition(storageRoot);
  const cdnManifest = readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const merged = mergeOfficialMarketplace(bundledManifest, cdnManifest);
  writeJsonFileSync(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

function mergeOfficialMarketplace(
  bundledManifest: Record<string, unknown> | undefined,
  remoteManifest: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const bundledPlugins = readPluginEntries(bundledManifest);
  const bundledNames = new Set(bundledPlugins.map(readPluginName).filter(isDefined));
  // fork 含同名 browser-use/skill-creator；远端不能覆盖 FCode 的内置运行能力和创建入口。
  const remotePlugins = readPluginEntries(remoteManifest).filter((plugin) => !bundledNames.has(readPluginName(plugin) ?? ""));
  return {
    ...bundledManifest,
    ...remoteManifest,
    name: FCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...remotePlugins, ...bundledPlugins],
  };
}

export async function stageOfficialMarketplace(input: {
  manifest: Record<string, unknown>;
  sourceRoot?: string;
  storageRoot: string;
  signal?: AbortSignal;
}): Promise<{ activation: AtomicDirectoryActivation; manifest: Record<string, unknown> }> {
  assertOfficialManifest(input.manifest);
  const target = dirname(partitionPath(input.storageRoot, MERGED_MARKETPLACE_FILE));
  const committed = recoverAtomicTargetSync(target);
  const bundled = readJsonRecord(join(committed, BUNDLED_PARTITION_FILE));
  const bundledManifest = bundled?.version === 1 && isRecord(bundled.manifest) ? bundled.manifest : undefined;
  const remote = { ...input.manifest };
  if (input.sourceRoot) {
    const sourceRoot = input.sourceRoot;
    const pluginRoot = typeof remote.pluginRoot === "string" ? remote.pluginRoot : ".";
    remote.plugins = readPluginEntries(remote).map((plugin) => {
      if (typeof plugin.source !== "string") return plugin;
      const resolvedPluginRoot = resolveInside(sourceRoot, pluginRoot);
      const path = resolvedPluginRoot && resolveInside(resolvedPluginRoot, plugin.source);
      if (!path) throw new Error(`Official plugin source escapes repository: ${plugin.name}`);
      return { ...plugin, source: `./repository/${relative(sourceRoot, path).split(sep).join("/")}` };
    });
    delete remote.pluginRoot;
  }
  const manifest = mergeOfficialMarketplace(bundledManifest, remote);
  const activation = await activateDirectoryAtomically({
    targetPath: target,
    authorityPath: join(input.storageRoot, "known_marketplaces.json"),
    signal: input.signal,
    prepare: async (stagedPath) => {
      if (input.sourceRoot) {
        const sourceRoot = input.sourceRoot;
        await cp(sourceRoot, join(stagedPath, "repository"), {
          recursive: true,
          filter: (path) => relative(sourceRoot, path).split(sep)[0] !== ".git",
        });
      }
      if (bundled) await writeFile(join(stagedPath, BUNDLED_PARTITION_FILE), `${JSON.stringify(bundled, null, 2)}\n`);
      await writeFile(join(stagedPath, CDN_PARTITION_FILE), `${JSON.stringify(remote, null, 2)}\n`);
      await writeFile(join(stagedPath, MERGED_MARKETPLACE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  });
  return { activation, manifest };
}

function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== FCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${FCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", FCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonFileSync(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 官方目录在每次启动都会重建；同内容反复写盘会增加 Windows 上
    // marketplace 文件被杀毒/索引器占用的概率。只跳过字节完全相同的单文件写入，
    // 读取失败或内容变化仍执行写入并保留原有失败语义。
    if (readFileSync(path, "utf8") === contents) return;
  } catch {
    // 文件不存在或暂时不可读时继续写，让真实更新失败继续向调用方暴露。
  }
  writeFileSync(path, contents, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
