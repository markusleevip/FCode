import type { ControlAction, ControlMethod, ControlObservation, ControlTarget } from "./control-contract.js";
export interface ControlContext {
  sessionId: string; turnId: string; workspaceKey: string; traceId: string;
  source: "user"; runtimeScope: "main"; pluginId: "computer-use@fcode-plugins-official";
}
export interface ControlLease { leaseId: string; epoch: number; sessionId: string; turnId: string; expiresAt: number }
export interface ControlRequest {
  action: ControlAction; target?: ControlTarget; observation?: ControlObservation;
  point?: { x: number; y: number }; endPoint?: { x: number; y: number };
  context: ControlContext & { expiresAt: number }; epoch: number; revision: number;
  callId: string; approved?: boolean;
}
export interface ControlResult { observation?: ControlObservation; [key: string]: unknown }
export interface ControlPorts {
  consumeObservations?: boolean;
  now(): number;
  createId(): string;
  isDenied(target: ControlTarget): boolean;
  resolveTarget(target: Record<string, unknown> | ControlTarget, signal: AbortSignal): Promise<ControlTarget>;
  requestApproval(request: ControlRequest, signal: AbortSignal): Promise<"allow" | "deny">;
  execute(request: ControlRequest, signal: AbortSignal): Promise<ControlResult>;
  stop(): Promise<void>;
}
export declare class CuaControlAuthority {
  constructor(ports: ControlPorts);
  readonly state: { enabled: boolean; epoch: number; queued: number; status: "stopping" | "active" | "idle"; lease: ControlLease | null };
  setEnabled(enabled: boolean): Promise<void> | undefined;
  registerTurn(context: ControlContext): void;
  closeTurn(sessionId: string, turnId: string): Promise<void> | undefined;
  closeSession(sessionId: string): void;
  registerCall(sessionId: string, turnId: string): string;
  closeCall(callId: string): void;
  grantApplication(callId: string, target: ControlTarget, methods: ControlMethod[], scope?: "turn" | "session"): string;
  revokeGrant(grantId: string): Promise<void> | undefined;
  acquire(callId: string): ControlLease;
  heartbeat(callId: string, leaseId: string): void;
  heartbeatTurn(sessionId: string, turnId: string, leaseId: string): void;
  stop(): Promise<void>;
  execute(callId: string, rawAction: unknown, signal?: AbortSignal): Promise<ControlResult>;
}
