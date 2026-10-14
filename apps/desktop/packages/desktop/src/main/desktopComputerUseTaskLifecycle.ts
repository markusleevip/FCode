import type { ComputerUseHostCommand } from "@fcode/shared";
import type { CuaInvocationRegistry, InvocationScope } from "@fcode/cua/invocation-registry";
import { CuaControlError } from "@fcode/cua/control-contract";
import type { DesktopComputerUsePanel, PanelOwner } from "./desktopComputerUsePanel.js";

/** A waiting/resume projection never starts a native child or restores an old capability. */
export function projectComputerUseOperation(panel: DesktopComputerUsePanel, registry: CuaInvocationRegistry,
  scope: Omit<InvocationScope, "workspaceKey">, command: Extract<ComputerUseHostCommand, { kind: "operation-event" }>,
  lifecycle: { stop(): Promise<void>; close(): Promise<void> }) {
  const owner = { ...scope, workspaceKey: command.workspaceKey, sessionId: command.event.sessionId,
    turnId: "turnId" in command.event ? command.event.turnId ?? "" : "", runtimeScope: "main" };
  const failed = command.event.kind === "turn-failed" && registry.isTurnActive(owner) &&
    panel.ownsTask(owner) && panel.getState(owner.ownerId).status === "active";
  registry.acceptEvent({ ...scope, workspaceKey: command.workspaceKey }, command.event);
  if (failed && !registry.isTurnActive(owner)) panel.fail(owner, "model_failed");
  if (command.event.kind === "turn-started" && registry.isTurnActive(owner)) panel.waiting(owner, {
    preview: async () => { throw new CuaControlError("target_unavailable"); },
    control: async () => { throw new CuaControlError("unsupported_action"); }, ...lifecycle,
  });
}

export async function stopComputerUseFailure(panel: DesktopComputerUsePanel, registry: CuaInvocationRegistry,
  owner: PanelOwner, error: unknown, stop: () => Promise<void>) {
  if (!registry.isTurnActive(owner) || !panel.ownsTask(owner) || panel.getState(owner.ownerId).status !== "active" ||
      (error instanceof CuaControlError && error.reason !== "protocol_mismatch" &&
      ["observation_stale", "target_changed", "control_busy", "invalid_request", "unsupported_action"].includes(error.code) &&
      !error.requiresUserAction)) return;
  panel.fail(owner, error instanceof CuaControlError && error.reason === "protocol_mismatch" ? "protocol_mismatch" :
    error instanceof CuaControlError && error.code === "secure_input_active" ? "secure_input_active" :
    error instanceof CuaControlError && error.code === "not_authorized" ? "not_authorized" :
    error instanceof CuaControlError && error.code === "control_busy" ? "control_busy" :
    error instanceof CuaControlError && ["permission_required", "permission_stale"].includes(error.code) ? "permission_required" : "backend_unavailable");
  await stop();
}
