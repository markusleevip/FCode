import { z } from "zod";
import { fcodeComputerUseOperationEventSchema } from "./fcode-protocol/index.js";
import { computerUsePreviewGeometrySchema, computerUseOperationPointerSchema } from "./computer-use-pointer.js";
export * from "./computer-use-pointer.js";

const identifier = z.string().trim().min(1).max(512);
export const computerUsePanelRequestSchema = z.object({
  sessionId: identifier,
  action: z.enum(["preview", "show", "pause", "handover", "stop"]),
}).strict();
export type ComputerUsePanelRequest = z.infer<typeof computerUsePanelRequestSchema>;
export const computerUsePanelStateSchema = z.object({
  sessionId: identifier.nullable(),
  status: z.enum(["none", "active", "paused", "handover", "ended"]),
  action: z.string().max(64).optional(),
  executing: z.boolean().optional(),
  stage: z.enum(["waiting_model", "preparing", "waiting_permission", "operating", "needs_resume", "ended"]).optional(),
  failureReason: z.enum(["task_inactive", "model_failed", "backend_unavailable", "permission_required", "not_authorized", "secure_input_active", "protocol_mismatch", "control_busy"]).optional(),
  inputRouting: z.enum(["background", "foreground"]).optional(),
  managed: z.boolean().optional(),
  target: z.string().max(512).optional(),
  applicationName: z.string().max(512).optional(),
  updatedAt: z.number().finite().optional(),
  image: z.string().max(6 * 1024 * 1024).optional(),
  previewFailed: z.boolean().optional(),
  previewGeometry: computerUsePreviewGeometrySchema.optional(),
  operationPointer: computerUseOperationPointerSchema.optional(),
}).strict();
export type ComputerUsePanelState = z.infer<typeof computerUsePanelStateSchema>;
export const computerUseCredentialUiRequestSchema = z.object({ sessionId: identifier }).strict();
export interface ComputerUseCredentialUiState {
  sessionId: string | null;
  status: "none" | "pending" | "ready";
  origin?: string;
}
export const COMPUTER_USE_PLUGIN_ID = "computer-use@fcode-plugins-official" as const;

export const computerUseIntentRequestSchema = z.object({
  pluginId: z.literal(COMPUTER_USE_PLUGIN_ID),
  commandId: identifier,
  workspaceKey: identifier,
  sessionId: identifier.nullable(),
}).strict();
export type ComputerUseIntentRequest = z.infer<typeof computerUseIntentRequestSchema>;

export const computerUseInvocationSchema = z.object({ token: z.string().uuid() }).strict();
export const computerUseCallContextSchema = z.object({
  sessionId: identifier, turnId: identifier, toolCallId: identifier, workspaceKey: identifier,
  runtimeScope: z.literal("main"),
}).strict();

export const computerUseHostCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("disable") }).strict(),
  z.object({ kind: z.literal("execute-control"), context: computerUseCallContextSchema, action: z.unknown() }).strict(),
  z.object({ kind: z.literal("cancel-call"), context: computerUseCallContextSchema }).strict(),
  computerUseIntentRequestSchema.omit({ pluginId: true }).extend({
    kind: z.literal("register-invocation"),
    token: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("operation-event"),
    workspaceKey: identifier,
    event: fcodeComputerUseOperationEventSchema,
  }).strict(),
]);
export type ComputerUseHostCommand = z.infer<typeof computerUseHostCommandSchema>;

export const computerUseHostResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: identifier, message: identifier,
    stage: z.enum(["selection", "host", "transport", "native", "execute"]).optional(),
    reason: z.enum(["task_not_selected", "task_inactive", "invocation_expired", "host_transport_unavailable", "helper_missing", "permission_required", "secure_input_active", "protocol_mismatch", "model_failed"]).optional(),
    retryable: z.boolean().optional(), requiresUserAction: z.boolean().optional(),
  }).strict() }).strict(),
]);
export type ComputerUseHostResult = z.infer<typeof computerUseHostResultSchema>;

export interface ComputerUseSubmissionPort {
  getRuntimeEnv?(): Record<string, string>;
  disableComputerUse?(): Promise<void>;
  registerInvocation(input: { token: string; commandId: string; workspaceKey: string; sessionId: string | null }): Promise<void>;
  acceptOperationEvent(workspaceKey: string, event: z.infer<typeof fcodeComputerUseOperationEventSchema>): void;
}

export const hostComputerUseCommandSchema = z.object({
  type: z.literal("computer-use-control-request"),
  requestId: z.string().uuid(),
  command: computerUseHostCommandSchema,
}).strict();
export const hostComputerUseResultSchema = z.object({
  type: z.literal("computer-use-control-result"),
  requestId: z.string().uuid(),
  result: computerUseHostResultSchema,
}).strict();
