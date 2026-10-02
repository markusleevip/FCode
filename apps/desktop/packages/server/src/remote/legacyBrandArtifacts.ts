import { access, cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LEGACY_BRAND, LEGACY_PLUGIN_DIRECTORY } from "@fcode/shared/branding-compatibility";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 校验 SHA 后，在受控缓存中建立新名副本；不修改下载归属、原始内容或真实用户配置。 */
export async function materializeLegacyBrandArtifacts(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const source = join(root, entry.name);
    const renamed =
      entry.name === `${LEGACY_BRAND}.cjs`
        ? "fcode.cjs"
        : entry.name === `${LEGACY_BRAND}-server.cjs`
          ? "fcode-server.cjs"
          : entry.name === LEGACY_PLUGIN_DIRECTORY
            ? ".fcode-plugin"
            : null;
    if (renamed) {
      const target = join(root, renamed);
      if (!(await exists(target))) {
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, {
          recursive: entry.isDirectory(),
          force: false,
          errorOnExist: true,
        });
      }
    }
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await materializeLegacyBrandArtifacts(source);
  }
}
