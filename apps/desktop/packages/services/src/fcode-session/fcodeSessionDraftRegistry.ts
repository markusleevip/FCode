import type { FCodeSessionStateSnapshot } from "@fcode/shared";
import type {
  FCodeSessionWorkspaceTarget,
  FCodeTaskTarget,
} from "#src/fcode-session/fcodeSession.js";

function getWorkspaceKey(target: FCodeSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: FCodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createFCodeDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: FCodeSessionWorkspaceTarget, snapshot: FCodeSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: FCodeTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: FCodeTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
