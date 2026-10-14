import { CUA_LIMITS, CuaControlError, canonicalAction } from "./control-contract.js";
import { sameRegion, sameTarget } from "./control-geometry.js";

const scopeKey = (context) => canonicalAction({ sessionId: context.sessionId, turnId: context.turnId,
  workspaceKey: context.workspaceKey, traceId: context.traceId });
const inputKey = (action) => {
  const { frameId: _frameId, stateId: _stateId, approvalId: _approvalId, ...params } = action.params;
  return canonicalAction({ method: action.method, params });
};
const elementKey = (request) => {
  const index = request.action.params.elementIndex;
  if (index === undefined) return null;
  const element = request.observation?.elements?.[index];
  if (!element) throw new CuaControlError("observation_stale", "The approved element is absent from this observation.");
  return canonicalAction({ role: element.role, subrole: element.subrole, title: element.AXTitle,
    description: element.AXDescription, region: element.region, enabled: element.enabled });
};

/** Host-only, bounded, one-use confirmations. Tokens never grant task or app access. */
export class CuaInputApprovalLedger {
  #ports;
  #entries = new Map();
  constructor(ports) { this.#ports = ports; }

  issue(request, observationBoundary) {
    this.#expire();
    if (this.#entries.size >= CUA_LIMITS.approvalCount) throw new CuaControlError("resource_limit");
    const id = this.#ports.createId();
    this.#entries.set(id, { scope: scopeKey(request.context), callId: request.callId, input: inputKey(request.action),
      target: structuredClone(request.target), observation: structuredClone(request.observation),
      element: elementKey(request), epoch: request.epoch, revision: request.revision,
      observationBoundary,
      expiresAt: Math.min(request.context.expiresAt, this.#ports.now() + CUA_LIMITS.approvalTtlMs) });
    return id;
  }

  consume(id, request) {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    if (!entry || entry.expiresAt <= this.#ports.now() || entry.callId !== request.callId || entry.scope !== scopeKey(request.context) ||
        entry.input !== inputKey(request.action) || entry.epoch !== request.epoch ||
        entry.revision !== request.revision || !sameTarget(entry.target, request.target)) {
      throw new CuaControlError("not_authorized", "No matching one-use input confirmation.");
    }
    if (entry.observation) {
      const next = request.observation;
      if (!next || next.id === entry.observation.id || next.registeredSequence <= entry.observationBoundary ||
          !sameRegion(next.region, entry.observation.region) ||
          next.topologyVersion !== entry.observation.topologyVersion || next.width !== entry.observation.width ||
          next.height !== entry.observation.height || elementKey(request) !== entry.element) {
        throw new CuaControlError("observation_stale", "Observe again with the approved target and geometry before input.");
      }
    }
  }
  revokeCall(callId) { for (const [id, entry] of this.#entries) if (entry.callId === callId) this.#entries.delete(id); }

  revokeTurn(sessionId, turnId) {
    for (const [id, entry] of this.#entries) {
      const scope = JSON.parse(entry.scope);
      if (scope.sessionId === sessionId && scope.turnId === turnId) this.#entries.delete(id);
    }
  }
  clear() { this.#entries.clear(); }
  #expire() { for (const [id, entry] of this.#entries) if (entry.expiresAt <= this.#ports.now()) this.#entries.delete(id); }
}
