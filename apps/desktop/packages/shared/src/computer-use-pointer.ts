import { z } from "zod";

const coordinate = z.number().finite();
const region = z.object({ x: coordinate, y: coordinate, width: coordinate.positive(), height: coordinate.positive() }).strict();
const target = z.object({ appId: z.string().max(512), pid: z.number().int().positive(),
  instanceId: z.string().max(512), windowId: z.number().int().positive() }).strict();
const page = z.object({ version: z.string().max(16384), region, scale: coordinate.positive().max(10) }).strict();

/** Private backend display receipts, never input authority or persisted history. */
export const computerUsePointerReceiptSchema = z.object({
  target, region, topologyVersion: z.string().max(16384),
  space: z.enum(["screen", "page"]), page: page.optional(),
  x: coordinate, y: coordinate,
  kind: z.enum(["pointer", "control-target"]), phase: z.enum(["position", "click", "drag"]),
  updatedAt: coordinate.nonnegative(),
}).strict();
export const computerUsePreviewFrameGeometrySchema = z.object({
  target, region, topologyVersion: z.string().max(16384),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  contentRegion: region.optional(), page: page.optional(),
}).strict();
export const computerUsePreviewGeometrySchema = z.object({
  revision: z.number().int().positive(), width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
}).strict();
export const computerUseOperationPointerSchema = z.object({
  previewRevision: z.number().int().positive(), sequence: z.number().int().positive(),
  x: coordinate.nonnegative(), y: coordinate.nonnegative(),
  kind: z.enum(["pointer", "control-target"]), phase: z.enum(["position", "click", "drag"]),
  updatedAt: coordinate.nonnegative(), expiresAt: coordinate.nonnegative(),
}).strict().refine((value) => value.expiresAt > value.updatedAt && value.expiresAt - value.updatedAt <= 3000);
export type ComputerUsePointerReceipt = z.infer<typeof computerUsePointerReceiptSchema>;
export type ComputerUsePreviewFrameGeometry = z.infer<typeof computerUsePreviewFrameGeometrySchema>;
export type ComputerUseOperationPointer = z.infer<typeof computerUseOperationPointerSchema>;
