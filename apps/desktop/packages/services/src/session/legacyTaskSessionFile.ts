import type { FCodeSessionFile, FCodeTaskMeta } from "@fcode/shared";
import { fcodeSessionFileSchema, fcodeTaskMetaSchema, fcodeTaskModeSchema } from "@fcode/shared";

export type LegacyTaskSessionFile = Omit<FCodeSessionFile, "meta"> & {
  meta: Omit<FCodeTaskMeta, "mode"> & { mode?: FCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = fcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: fcodeTaskMetaSchema.extend({
    mode: fcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
