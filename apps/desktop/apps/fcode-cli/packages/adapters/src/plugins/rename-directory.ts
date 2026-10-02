import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function renameDirectory(source: string, target: string): Promise<void> {
  // Windows 办公插件真机更新曾在 cp 完成后的 rename 遇到临时 EPERM。
  // 保持同一事务 reservation，仅重试文件锁类 IO 错误；不放宽 owner/authority 校验。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EBUSY"].includes(code ?? "") ||
        attempt >= 5
      ) {
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }
}
