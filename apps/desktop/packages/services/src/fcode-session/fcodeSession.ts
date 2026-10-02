import { ServiceChannels } from "@fcode/shared";
import type {
  TraceId,
  FCodeAgentMcpServer,
  FCodeDeliveryKind,
  FCodeMessageWithParts,
  ModelSelection,
  FCodePermissionRequestParams,
  FCodeUserInputRequestParams,
  FCodeUserInputResponse,
  FCodeSessionInfo,
  FCodeSessionImportHistory,
  FCodeSessionEvent,
  FCodeSessionMode,
  FCodeSessionPersistence,
  FCodeSessionStateSnapshot,
  FCodeStateUpdatedNotification,
  FCodeWorkspacePresentation,
} from "@fcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface FCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type FCodeSessionReadWorkspacePresentationParams = FCodeSessionWorkspaceTarget;

export interface FCodeTaskTarget extends FCodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface FCodeSessionCreateParams extends FCodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: FCodeSessionMode;
  model?: ModelSelection;
  persistence?: FCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: FCodeAgentMcpServer[];
  importedHistory?: FCodeSessionImportHistory;
}

export interface FCodeSessionResumeParams extends FCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: FCodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface FCodeSessionListParams extends FCodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface FCodeSessionReadParams extends FCodeTaskTarget {
  deliveryKind?: FCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface FCodeSessionMessagesParams extends FCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface FCodeSessionEventsParams extends FCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface FCodeSessionSetModelParams extends FCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface FCodeSessionSetThoughtLevelParams extends FCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface FCodeSessionSetModeParams extends FCodeTaskTarget {
  mode: FCodeSessionMode;
  expectedRevision?: number;
}

export interface FCodeSessionSubscribeParams extends FCodeTaskTarget {
  deliveryKind: FCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type FCodeSessionServiceEvent =
  | { type: "session.event"; event: FCodeSessionEvent }
  | { type: "state.updated"; notification: FCodeStateUpdatedNotification }
  | { type: "permission.request"; request: FCodePermissionRequestParams }
  | { type: "userInput.request"; request: FCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: FCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: FCodeSessionStateSnapshot };

export interface FCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface FCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IFCodeSessionService {
  initializeWorkspace(params: FCodeSessionWorkspaceTarget): Promise<FCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: FCodeSessionWorkspaceTarget,
  ): Promise<FCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: FCodeSessionReadWorkspacePresentationParams,
  ): Promise<FCodeWorkspacePresentation>;
  createSession(params: FCodeSessionCreateParams): Promise<FCodeSessionStateSnapshot>;
  resumeSession(params: FCodeSessionResumeParams): Promise<FCodeSessionStateSnapshot>;
  listSessions(params: FCodeSessionListParams): Promise<FCodeSessionInfo[]>;
  readSession(params: FCodeSessionReadParams): Promise<FCodeSessionStateSnapshot>;
  readSessionMessages(params: FCodeSessionMessagesParams): Promise<FCodeMessageWithParts[]>;
  readSessionEvents(params: FCodeSessionEventsParams): Promise<FCodeSessionEvent[]>;
  promoteDeferredDraftSession(params: FCodeTaskTarget): Promise<void>;
  closeSession(params: FCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: FCodeTaskTarget): Promise<boolean>;
  setModel(params: FCodeSessionSetModelParams): Promise<FCodeSessionStateSnapshot>;
  setThoughtLevel(params: FCodeSessionSetThoughtLevelParams): Promise<FCodeSessionStateSnapshot>;
  setMode(params: FCodeSessionSetModeParams): Promise<FCodeSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const IFCodeSessionService = createServiceDescriptor<IFCodeSessionService>(
  ServiceChannels.FCodeSession,
);
