import { z } from "zod";

/**
 * FCode agent 提供方的单一真源。
 *
 * 类型 FCodeProvider、运行时 schema fcodeProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / fcode-protocol 等无环引用。
 */
const FCODE_PROVIDERS = ["glm"] as const;

export const fcodeProviderSchema = z.enum(FCODE_PROVIDERS);

export type FCodeProvider = (typeof FCODE_PROVIDERS)[number];
