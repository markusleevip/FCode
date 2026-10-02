import { resolveFCodePath } from "@fcode/shared/branding-paths";
/**
 * 数据根解析：R1 = 家目录下的 .fcode，R2 = 自定义数据存储路径下的应用数据根（仅当设置了且 ≠ 家目录）。
 * 路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），模块内不读环境变量。
 */
import { resolve } from "node:path";
import { resolveDataRootDir } from "#src/paths.js";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@fcode/shared";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: resolveFCodePath(home), hasCustomDataBaseDir },
  ];
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: resolveDataRootDir(dataBase),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}
