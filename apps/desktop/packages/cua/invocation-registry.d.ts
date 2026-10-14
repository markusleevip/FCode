import type { ControlContext } from "./control-authority.js";
export interface InvocationScope { ownerId: string; hostId: string; workspaceKey: string }
export interface InvocationIntent { ownerId: string; workspaceKey: string; commandId: string; sessionId: string | null; pluginId: string }
export interface InvocationEvent {
  kind: "turn-started" | "turn-completed" | "turn-failed" | "session-closed" | "tool-scheduled" | "tool-started" | "tool-completed";
  sequenceNumber: number; sessionId: string; turnId?: string; inputId?: string; messageId?: string;
  traceId?: string; humanUser?: boolean; toolCallId?: string; toolName?: string;
}
export interface InvocationCall extends InvocationScope, ControlContext {
  inputId: string; messageId: string; generation: string; toolCallId: string; callId: string; expiresAt: number;
}
export declare class CuaInvocationRegistry {
  constructor(ports: {
    now(): number; createId(): string; registerTurn(context: ControlContext): void;
    registerCall(sessionId: string, turnId: string): string;
    closeTurn(sessionId: string, turnId: string): unknown; closeCall(callId: string): unknown;
  });
  prepareIntent(input: InvocationIntent): string;
  consumeIntent(input: InvocationScope & Omit<InvocationIntent, "pluginId"> & { token: string }): void;
  acceptEvent(scope: InvocationScope, event: InvocationEvent): void;
  resolveCall(input: InvocationScope & { sessionId: string; turnId: string; toolCallId: string; runtimeScope: string }): InvocationCall;
  closeToolCall(input: InvocationScope & { sessionId: string; turnId: string; toolCallId: string }): void;
  isTurnActive(input: InvocationScope & { sessionId: string; turnId: string; runtimeScope: string }): boolean;
  revokeHost(hostId: string): void;
  revokeOwner(ownerId: string): void;
  clear(): void;
}
