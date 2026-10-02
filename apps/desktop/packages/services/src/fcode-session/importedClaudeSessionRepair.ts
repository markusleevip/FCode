import type { FCodeSessionStateSnapshot } from "@fcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { IFCodeAgentService } from "#src/fcode-agent/fcodeAgent.js";
import type {
  FCodeSessionReadParams,
  FCodeSessionResumeParams,
} from "#src/fcode-session/fcodeSession.js";

const logger = createServiceLogger("fcode-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: IFCodeAgentService;
  snapshot: FCodeSessionStateSnapshot;
  target: FCodeSessionResumeParams | FCodeSessionReadParams;
}): Promise<FCodeSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[fcode-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}
