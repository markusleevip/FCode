import { relative, sep } from "node:path";

const excludedDirectories = new Set([
  "test",
  "tests",
  "__tests__",
  "example",
  "examples",
  "fixtures",
]);

export function createRuntimePackageCopyFilter(packageRoot) {
  // afterPack 复制整个依赖包会重新带入已被初始 files 规则裁掉的测试与测试凭据。
  // 只判断包内相对目录，保留运行资源、package.json 与原始许可材料。
  return (source) => {
    const path = relative(packageRoot, source);
    return !path.split(sep).some((part) => excludedDirectories.has(part.toLowerCase()));
  };
}
