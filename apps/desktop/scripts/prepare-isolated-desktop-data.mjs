import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareIsolatedDesktopData({ baseDir, userHome }) {
  if (!baseDir || !userHome || resolve(baseDir) === resolve(userHome)) {
    throw new Error("An explicit isolated data directory distinct from user home is required.");
  }
  const primary = join(baseDir, ".fcode");
  const legacy = join(baseDir, ".zcode");
  const importing = join(baseDir, ".fcode-importing");
  // 旧条件同时判断同一目录存在/不存在，永远不执行；只迁移隔离旧根且不覆盖新根。
  if (!(await exists(primary)) && (await exists(legacy))) {
    if (await exists(importing)) throw new Error("Previous isolated data copy is incomplete.");
    await mkdir(importing, { recursive: false });
    // 临时根由 mkdir 独占，逐项复制避免 cp 把已占有的临时根当作覆盖目标。
    for (const name of await readdir(legacy)) {
      await cp(join(legacy, name), join(importing, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    if (await exists(primary))
      throw new Error("Isolated target appeared during data copy; nothing overwritten.");
    await rename(importing, primary);
  }

  const target = join(primary, "v2", "setting.json");
  if (await exists(target)) return;
  // 原启动脚本未注入 desktop home，设置落到真实 home；缺失才导入，源文件始终只读。
  const sources = [
    join(userHome, ".fcode", "v2", "setting.json"),
    join(userHome, ".zcode", "v2", "setting.json"),
  ];
  for (const source of sources) {
    if (!(await exists(source))) continue;
    await mkdir(join(primary, "v2"), { recursive: true });
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await prepareIsolatedDesktopData({
      baseDir: process.env.FCODE_DATA_BASE_DIR,
      userHome: process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir(),
    });
  } catch (error) {
    console.error("[ERROR] Isolated desktop data preparation failed:", error.message);
    process.exitCode = 1;
  }
}
