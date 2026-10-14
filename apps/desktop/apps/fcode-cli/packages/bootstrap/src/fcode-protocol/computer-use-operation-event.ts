import { SessionEventType, type SessionEvent } from "@fcode/contracts";
import type { FCodeComputerUseOperationEvent } from "@fcode/shared";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Presentation hint only. Source text never grants authority to a tool call. */
function usesComputerUse(input: unknown): boolean {
  const code = nonEmptyString(asRecord(input).code);
  if (!code) return false;
  return code.includes("setupComputerUseRuntime");
}

function baseEvent(event: SessionEvent) {
  return {
    eventId: String(event.id),
    sequenceNumber: event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
  };
}

export function mapComputerUseOperationEvent(
  event: SessionEvent,
): FCodeComputerUseOperationEvent | undefined {
  const turnId = event.turnId ? String(event.turnId) : undefined;
  const payload = asRecord(event.payload);
  switch (event.type) {
    case SessionEventType.TurnStarted:
      return turnId ? {
        ...baseEvent(event), kind: "turn-started", turnId,
        ...(nonEmptyString(payload.inputId) ? { inputId: String(payload.inputId) } : {}),
        ...(nonEmptyString(payload.messageId) ? { messageId: String(payload.messageId) } : {}),
        traceId: String(event.traceId),
        humanUser: !payload.inputSource && !payload.originMeta && !payload.backgroundSource &&
          !payload.automationId && !payload.offPeakTaskId && payload.inputVisibility !== "model-only",
      } : undefined;
    case SessionEventType.TurnComplete:
      return turnId ? { ...baseEvent(event), kind: "turn-completed", turnId } : undefined;
    case SessionEventType.TurnError:
      return turnId ? { ...baseEvent(event), kind: "turn-failed", turnId } : undefined;
    case SessionEventType.ToolCallScheduled: {
      const toolCallId = nonEmptyString(payload.toolCallId);
      const toolName = nonEmptyString(payload.toolName);
      return turnId && toolCallId && toolName
        ? {
            ...baseEvent(event),
            kind: "tool-scheduled",
            turnId,
            toolCallId,
            toolName,
            ...(toolName === "mcp__node_repl__js" && usesComputerUse(payload.input)
              ? { computerUse: true as const }
              : {}),
          }
        : undefined;
    }
    case SessionEventType.ToolCallStarted: {
      const toolCallId = nonEmptyString(payload.toolCallId);
      if (!toolCallId) return undefined;
      const toolName = nonEmptyString(payload.toolName);
      return {
        ...baseEvent(event),
        kind: "tool-started",
        ...(turnId ? { turnId } : {}),
        toolCallId,
        ...(toolName ? { toolName } : {}),
      };
    }
    case SessionEventType.SessionEnded:
      return { ...baseEvent(event), kind: "session-closed" };
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError: {
      const toolCallId = nonEmptyString(payload.toolCallId);
      return toolCallId ? { ...baseEvent(event), kind: "tool-completed", toolCallId,
        ...(turnId ? { turnId } : {}) } : undefined;
    }
    default:
      return undefined;
  }
}
