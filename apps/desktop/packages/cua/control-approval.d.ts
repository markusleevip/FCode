import type { ControlRequest } from "./control-authority.js";
export declare class CuaInputApprovalLedger {
  constructor(ports: { now(): number; createId(): string });
  issue(request: ControlRequest, observationBoundary: number): string;
  consume(id: string, request: ControlRequest): void;
  revokeTurn(sessionId: string, turnId: string): void;
  revokeCall(callId: string): void;
  clear(): void;
}
