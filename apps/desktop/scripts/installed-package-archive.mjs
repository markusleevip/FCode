import { sep } from "node:path";

export function readInstalledArchiveFile(asar, archive, portablePath) {
  // Windows asar 按 path.sep 解析条目；策略清单的斜杠路径必须在读取边界转换。
  return asar.extractFile(archive, portablePath.replaceAll("/", sep));
}
