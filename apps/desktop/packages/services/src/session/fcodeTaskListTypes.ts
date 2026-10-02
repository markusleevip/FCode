import type { WorkspacePurpose, FCodeTaskMeta } from "@fcode/shared";

export type FCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type FCodeTaskListSortBy = "created" | "updated";

export interface FCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface FCodeTaskListQuery {
  kind: FCodeTaskListKind;
  workspaceScopes: FCodeTaskListWorkspaceScope[];
  sortBy: FCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type FCodeTaskListItem = FCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface FCodeTaskListResult {
  items: FCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type FCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface FCodeTaskGroup {
  id: string;
  title: string;
  color: FCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface FCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type FCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: FCodeGroupedTaskRef };

export type FCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: FCodeTaskGroup;
      tasks: FCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: FCodeTaskListItem;
      sortOrder?: number;
    };

export interface FCodeGroupedTaskView {
  nodes: FCodeGroupedTaskViewNode[];
}

export interface FCodeGroupedTaskViewQuery {
  workspaceScopes: FCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface FCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type FCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface FCodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: FCodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: FCodeGroupedTaskViewStructureMember[];
  topLevelOrders: FCodeGroupedTaskViewStructureTopOrder[];
}

export interface FCodeGroupedTaskViewOrderInput {
  workspaceScopes: FCodeTaskListWorkspaceScope[];
  topLevelNodes: FCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: FCodeGroupedTaskRef[];
  }>;
}

export interface FCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
