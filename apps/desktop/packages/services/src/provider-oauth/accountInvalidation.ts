import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** 监听父目录，原子替换后仍观察目标文件；仅通知原账号 source 重读，不缓存凭据。 */
export async function bindProviderOAuthAccountInvalidation(options: {
  credentialFilePath: string;
  refresh: (reason: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}): Promise<() => void> {
  const directory = dirname(options.credentialFilePath);
  const target = basename(options.credentialFilePath);
  await mkdir(directory, { recursive: true });
  let disposed = false;
  const request = () => {
    void options.refresh("native-account-file-changed").catch((error) => {
      if (!disposed) options.onError(error);
    });
  };
  const watcher = watch(directory, { persistent: false }, (_event, filename) => {
    // 平台未提供文件名时必须重读；其他凭据文件临时写入不发布账号事实。
    if (!disposed && (filename === null || filename.toString() === target)) request();
  });
  watcher.on("error", (error) => {
    if (!disposed) options.onError(error);
  });
  return () => {
    disposed = true;
    watcher.close();
  };
}
