import type { FCodeMessageWithParts } from "./fcode-protocol-legacy-types.js";
import { textFromFCodeMessageParts } from "./fcode-protocol-legacy-types.js";
import type { FCodeStreamEvent } from "./fcode-task-types-core.js";

export interface FCodeBackgroundTaskNotificationInfo {
  error?: string;
  outputFile?: string;
  result?: string;
  status?: string;
  summary?: string;
  taskId?: string;
}

export function parseFCodeBackgroundTaskNotificationText(
  text: string | undefined,
): { notification: FCodeBackgroundTaskNotificationInfo; toolUseId: string } | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("<task-notification>")) {
    return null;
  }
  const toolUseId = readTaskNotificationTag(trimmed, "tool-use-id");
  if (!toolUseId) {
    return null;
  }
  return {
    toolUseId,
    notification: {
      error: readTaskNotificationTag(trimmed, "error"),
      outputFile: readTaskNotificationTag(trimmed, "output-file"),
      result: readTaskNotificationTag(trimmed, "result"),
      status: readTaskNotificationTag(trimmed, "status"),
      summary: readTaskNotificationTag(trimmed, "summary"),
      taskId: readTaskNotificationTag(trimmed, "task-id"),
    },
  };
}

export function collectFCodeBackgroundTaskNotificationsByToolUseId(
  messages: readonly FCodeMessageWithParts[],
): Map<string, FCodeBackgroundTaskNotificationInfo> {
  const notifications = new Map<string, FCodeBackgroundTaskNotificationInfo>();
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }
    const parsed = parseFCodeBackgroundTaskNotificationText(
      textFromFCodeMessageParts(message.parts),
    );
    if (!parsed) {
      continue;
    }
    notifications.set(parsed.toolUseId, parsed.notification);
  }
  return notifications;
}

export function fcodeBackgroundTaskNotificationToolUpdateStatus(
  status: string | undefined,
): Extract<
  Extract<FCodeStreamEvent, { type: "tool_call_update" }>["status"],
  "completed" | "failed" | "stopped"
> {
  if (status === "failed" || status === "lost") {
    return "failed";
  }
  // task-notification 的 killed/stopped 都表示被停止，不能折成 completed。
  if (status === "stopped" || status === "killed") {
    return "stopped";
  }
  return "completed";
}

export function attachFCodeBackgroundTaskNotificationToRaw(
  raw: unknown,
  notification: FCodeBackgroundTaskNotificationInfo | undefined,
): unknown {
  if (!notification) {
    return raw;
  }
  const record = asPlainRecord(raw);
  const meta = asPlainRecord(record._meta);
  const fcode = asPlainRecord(meta.fcode);
  return {
    ...record,
    _meta: {
      ...meta,
      fcode: {
        ...fcode,
        taskNotification: notification,
      },
    },
  };
}

function readTaskNotificationTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  const value = match?.[1]?.trim();
  return value ? decodeTaskNotificationXmlText(value) : undefined;
}

function decodeTaskNotificationXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
