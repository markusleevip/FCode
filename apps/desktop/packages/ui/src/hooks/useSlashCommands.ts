/**
 * FCode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useFCodeSessionStore, selectWorkspaceFCodeState } from "../store/fcodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useFCodeSessionStore(
    (state) => selectWorkspaceFCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
