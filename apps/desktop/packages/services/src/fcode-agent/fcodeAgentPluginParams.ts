import type {
  FCodeAgentMcpServer,
  FCodeAutomationScheduleRule,
  FCodeMcpListMode,
  ModelSelection,
} from "@fcode/shared";

export interface FCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface FCodeAgentPluginViewParams extends FCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface FCodeAgentListMcpServerStatusesParams extends FCodeAgentWorkspaceTarget {
  mcpServers?: FCodeAgentMcpServer[];
  mode?: FCodeMcpListMode;
}

export interface FCodeAgentAddPluginMarketplaceParams extends FCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface FCodeAgentRemovePluginMarketplaceParams extends FCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface FCodeAgentUpdatePluginMarketplaceParams extends FCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface FCodeAgentInstallPluginParams extends FCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface FCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface FCodeAgentUninstallPluginParams extends FCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface FCodeAgentUpdatePluginParams extends FCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface FCodeAgentRestoreBuiltinPluginParams extends FCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface FCodeAgentConfigurePluginParams extends FCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface FCodeAgentResetPluginConfigParams extends FCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface FCodeAgentValidatePluginParams extends FCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface FCodeAgentDescribePluginParams extends FCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface FCodeAgentSetPluginEnabledParams extends FCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface FCodeAgentPluginReferenceCatalogParams extends FCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface FCodeAgentSkillReferenceCatalogParams extends FCodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface FCodeAgentResolveSuggestedPluginReferenceParams extends FCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface FCodeAgentCreateAutomationParams extends FCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: FCodeAutomationScheduleRule;
}

export interface FCodeAgentUpdateAutomationParams extends FCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: FCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface FCodeAgentAutomationIdParams extends FCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface FCodeAgentSetAutomationEnabledParams extends FCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface FCodeAgentDeleteAutomationRunParams extends FCodeAgentWorkspaceTarget {
  runId: string;
}
