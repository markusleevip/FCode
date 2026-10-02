/* eslint-disable max-lines -- grouped task 的纯 view helper 暂时集中维护 task/group 重排、菜单移动和乐观合并，后续按拖拽域继续拆分。 */
import type { FCodeGroupedTaskView, FCodeGroupedTaskViewNode } from "@fcode/services";
import type { FCodeTaskMeta } from "@fcode/shared";
import type { GroupedDraftTaskPlacement } from "@/store/fcodeSessionStoreTypes.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";

function cloneView(view: FCodeGroupedTaskView): FCodeGroupedTaskView {
  return {
    nodes: view.nodes.map((node) =>
      node.type === "task" ? { ...node } : { ...node, tasks: [...node.tasks] },
    ),
  };
}

function cloneNodes(view: FCodeGroupedTaskView): FCodeGroupedTaskViewNode[] {
  return [...view.nodes];
}

function cloneGroupNode(
  node: Extract<FCodeGroupedTaskViewNode, { type: "group" }>,
): Extract<FCodeGroupedTaskViewNode, { type: "group" }> {
  return { ...node, tasks: [...node.tasks] };
}

function removeTaskFromView(
  view: FCodeGroupedTaskView,
  targetTaskKey: string,
): {
  nextView: FCodeGroupedTaskView;
  task: FCodeTaskMeta | null;
} {
  const nodes = cloneNodes(view);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      nodes.splice(index, 1);
      return { nextView: { nodes }, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const nextGroupNode = cloneGroupNode(node);
        const [task] = nextGroupNode.tasks.splice(taskIndex, 1);
        nodes[index] = nextGroupNode;
        return { nextView: { nodes }, task: task ?? null };
      }
    }
  }
  return { nextView: { nodes }, task: null };
}

function insertTaskIntoGroup(
  view: FCodeGroupedTaskView,
  task: FCodeTaskMeta,
  groupId: string,
  beforeTaskKey: string | null,
): FCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const groupIndex = nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
  const groupNode = nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex =
    beforeTaskKey === null
      ? nextGroupNode.tasks.length
      : nextGroupNode.tasks.findIndex((item) => taskKey(item) === beforeTaskKey);
  nextGroupNode.tasks.splice(insertIndex < 0 ? nextGroupNode.tasks.length : insertIndex, 0, task);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

function removeTaskFromGroupedView(
  view: FCodeGroupedTaskView,
  targetTaskKey: string,
): FCodeGroupedTaskView {
  const nextView = cloneView(view);
  for (const node of nextView.nodes) {
    if (node.type !== "group") {
      continue;
    }
    const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
    if (taskIndex >= 0) {
      node.tasks.splice(taskIndex, 1);
      return nextView;
    }
  }

  const nodeIndex = nextView.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
  if (nodeIndex >= 0) {
    nextView.nodes.splice(nodeIndex, 1);
  }
  return nextView;
}

function filterGroupedViewByTaskKeys(
  view: FCodeGroupedTaskView,
  hiddenTaskKeys: ReadonlySet<string>,
): FCodeGroupedTaskView {
  if (hiddenTaskKeys.size === 0) {
    return view;
  }

  let changed = false;
  const nodes: FCodeGroupedTaskView["nodes"] = [];
  for (const node of view.nodes) {
    if (node.type === "task") {
      if (!hiddenTaskKeys.has(taskKey(node.task))) {
        nodes.push(node);
      } else {
        changed = true;
      }
      continue;
    }

    const tasks = node.tasks.filter((task) => !hiddenTaskKeys.has(taskKey(task)));
    if (tasks.length === node.tasks.length) {
      nodes.push(node);
      continue;
    }
    changed = true;
    nodes.push({ ...node, tasks });
  }

  return changed ? { nodes } : view;
}

function findTaskInGroupedView(
  view: FCodeGroupedTaskView,
  targetTaskKey: string,
): FCodeTaskMeta | null {
  for (const node of view.nodes) {
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return node.task;
    }
    if (node.type === "group") {
      const task = node.tasks.find((item) => taskKey(item) === targetTaskKey);
      if (task) {
        return task;
      }
    }
  }
  return null;
}

function replaceTaskInGroupedView(
  view: FCodeGroupedTaskView,
  nextTask: FCodeTaskMeta,
): FCodeGroupedTaskView {
  const targetTaskKey = taskKey(nextTask);
  return {
    nodes: view.nodes.map((node) => {
      if (node.type === "task") {
        return taskKey(node.task) === targetTaskKey ? { ...node, task: nextTask } : node;
      }
      return {
        ...node,
        tasks: node.tasks.map((task) => (taskKey(task) === targetTaskKey ? nextTask : task)),
      };
    }),
  };
}

function getGroupedTaskGroupIds(view: FCodeGroupedTaskView): string[] {
  return view.nodes.flatMap((node) => (node.type === "group" ? [node.group.id] : []));
}

function areAllGroupedTaskGroupsExpanded(
  groupIds: readonly string[],
  collapsedGroupIds: ReadonlySet<string>,
): boolean {
  return groupIds.length > 0 && groupIds.every((groupId) => !collapsedGroupIds.has(groupId));
}

function pruneCollapsedGroupedTaskGroupIds(
  collapsedGroupIds: ReadonlySet<string>,
  groupIds: readonly string[],
): Set<string> {
  const knownGroupIds = new Set(groupIds);
  return new Set([...collapsedGroupIds].filter((groupId) => knownGroupIds.has(groupId)));
}

function getTaskGroupIdInView(view: FCodeGroupedTaskView, targetTaskKey: string): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

type GroupedTaskLocation =
  | {
      parent: "root";
      nodeIndex: number;
      task: FCodeTaskMeta;
    }
  | {
      parent: "group";
      groupId: string;
      nodeIndex: number;
      taskIndex: number;
      task: FCodeTaskMeta;
    };

type GroupedTaskInsertPosition = "before" | "after";

function findTopLevelTaskIndex(view: FCodeGroupedTaskView, targetTaskKey: string): number {
  return view.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
}

function findGroupIndex(view: FCodeGroupedTaskView, groupId: string): number {
  return view.nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
}

function findGroupIdByTaskKey(view: FCodeGroupedTaskView, targetTaskKey: string): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

function findTaskLocation(
  view: FCodeGroupedTaskView,
  targetTaskKey: string,
): GroupedTaskLocation | null {
  for (let nodeIndex = 0; nodeIndex < view.nodes.length; nodeIndex += 1) {
    const node = view.nodes[nodeIndex];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return { parent: "root", nodeIndex, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const task = node.tasks[taskIndex];
        if (!task) {
          return null;
        }
        return {
          parent: "group",
          groupId: node.group.id,
          nodeIndex,
          taskIndex,
          task,
        };
      }
    }
  }
  return null;
}

function resolveGroupedDraftTaskPlacementForTask(
  view: FCodeGroupedTaskView,
  targetTaskKey: string | null | undefined,
): GroupedDraftTaskPlacement {
  if (!targetTaskKey) {
    return { type: "top" };
  }
  const location = findTaskLocation(view, targetTaskKey);
  return location?.parent === "group"
    ? { type: "group", groupId: location.groupId }
    : { type: "top" };
}

function insertTaskNearTask(
  view: FCodeGroupedTaskView,
  task: FCodeTaskMeta,
  overTaskKey: string,
  position: GroupedTaskInsertPosition,
): FCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const overLocation = findTaskLocation({ nodes }, overTaskKey);
  if (!overLocation) {
    return { nodes };
  }

  if (overLocation.parent === "root") {
    const insertIndex = overLocation.nodeIndex + (position === "after" ? 1 : 0);
    nodes.splice(insertIndex, 0, { type: "task", task });
    return { nodes };
  }

  const groupNode = nodes[overLocation.nodeIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex = overLocation.taskIndex + (position === "after" ? 1 : 0);
  nextGroupNode.tasks.splice(insertIndex, 0, task);
  nodes[overLocation.nodeIndex] = nextGroupNode;
  return { nodes };
}

function moveTaskOverTask(
  view: FCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    overTaskKey: string;
    position: GroupedTaskInsertPosition;
  },
): FCodeGroupedTaskView {
  if (params.activeTaskKey === params.overTaskKey) {
    return view;
  }
  const activeLocation = findTaskLocation(view, params.activeTaskKey);
  const overLocation = findTaskLocation(view, params.overTaskKey);
  if (!activeLocation || !overLocation) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }

  // task over task 的目标父级由 over task 所在层级决定。
  // 先移除 active 再按 over task 重新定位，避免同组向下移动时旧 index 把插入点推后一格。
  return insertTaskNearTask(nextView, task, params.overTaskKey, params.position);
}

function insertTaskAroundGroup(
  view: FCodeGroupedTaskView,
  task: FCodeTaskMeta,
  groupId: string,
  position: GroupedTaskInsertPosition,
): FCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const groupIndex = nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
  if (groupIndex < 0) {
    return { nodes };
  }
  nodes.splice(groupIndex + (position === "after" ? 1 : 0), 0, { type: "task", task });
  return { nodes };
}

function moveTaskToRootAroundGroup(
  view: FCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
    position: GroupedTaskInsertPosition;
  },
): FCodeGroupedTaskView {
  const groupNode = view.nodes.find(
    (node) => node.type === "group" && node.group.id === params.groupId,
  );
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }

  return insertTaskAroundGroup(nextView, task, params.groupId, params.position);
}

function moveTaskToGroupStart(
  view: FCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): FCodeGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupNode = nextView.nodes.find(
    (node) => node.type === "group" && node.group.id === params.groupId,
  );
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
  return insertTaskIntoGroup(nextView, task, params.groupId, firstTaskKey);
}

function moveTaskToGroupEnd(
  view: FCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): FCodeGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupIndex = findGroupIndex(nextView, params.groupId);
  const groupNode = nextView.nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  nextGroupNode.tasks.push(task);
  const nodes = cloneNodes(nextView);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

function moveGroupAroundTopLevelNode(
  view: FCodeGroupedTaskView,
  params: {
    activeGroupId: string;
    over:
      | {
          type: "group";
          groupId: string;
        }
      | {
          type: "task";
          taskKey: string;
        };
    position: GroupedTaskInsertPosition;
  },
): FCodeGroupedTaskView {
  if (params.over.type === "group" && params.activeGroupId === params.over.groupId) {
    return view;
  }
  // group 拖到另一个 group 的 content 上时，collision 可能返回组内 task；
  // 这里把组内 task 归一化为所属 group，避免 content 区域不触发 group over group。
  const overGroupId =
    params.over.type === "task" ? findGroupIdByTaskKey(view, params.over.taskKey) : null;
  if (overGroupId === params.activeGroupId) {
    return view;
  }
  const nodes = cloneNodes(view);
  const activeIndex = nodes.findIndex(
    (node) => node.type === "group" && node.group.id === params.activeGroupId,
  );
  if (activeIndex < 0) {
    return view;
  }
  const [activeNode] = nodes.splice(activeIndex, 1);
  if (!activeNode || activeNode.type !== "group") {
    return view;
  }
  const nextView = { nodes };
  const overIndex =
    params.over.type === "group"
      ? findGroupIndex(nextView, params.over.groupId)
      : overGroupId
        ? findGroupIndex(nextView, overGroupId)
        : findTopLevelTaskIndex(nextView, params.over.taskKey);
  if (overIndex < 0) {
    return view;
  }
  nodes.splice(overIndex + (params.position === "after" ? 1 : 0), 0, activeNode);
  return { nodes };
}

function getNodeIdAfterGroup(
  view: FCodeGroupedTaskView,
  groupId: string,
): FCodeGroupedTaskViewNode | null {
  const groupIndex = view.nodes.findIndex(
    (node) => node.type === "group" && node.group.id === groupId,
  );
  return groupIndex >= 0 ? (view.nodes[groupIndex + 1] ?? null) : null;
}

function insertTaskBeforeTopLevelNode(
  view: FCodeGroupedTaskView,
  task: FCodeTaskMeta,
  beforeNode: FCodeGroupedTaskViewNode | null,
): FCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const insertIndex =
    beforeNode === null
      ? nodes.length
      : nodes.findIndex((node) =>
          beforeNode.type === "group"
            ? node.type === "group" && node.group.id === beforeNode.group.id
            : node.type === "task" && taskKey(node.task) === taskKey(beforeNode.task),
        );
  nodes.splice(insertIndex < 0 ? nodes.length : insertIndex, 0, {
    type: "task",
    task,
  });
  return { nodes };
}

function moveTaskByMenu(
  view: FCodeGroupedTaskView,
  targetTask: FCodeTaskMeta,
  targetGroupId: string | null,
): FCodeGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const currentGroupId = getTaskGroupIdInView(view, targetTaskKey);
  if (currentGroupId === targetGroupId) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }
  if (targetGroupId) {
    return insertTaskIntoGroup(nextView, task, targetGroupId, null);
  }

  // 菜单移出分组时把 task 放到原 group 后面，避免用户刚操作完就丢失空间上下文。
  const beforeNode = currentGroupId ? getNodeIdAfterGroup(view, currentGroupId) : null;
  return insertTaskBeforeTopLevelNode(nextView, task, beforeNode);
}

function moveTaskToTopByMenu(
  view: FCodeGroupedTaskView,
  targetTask: FCodeTaskMeta,
): FCodeGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const location = findTaskLocation(view, targetTaskKey);
  if (
    !location ||
    (location.parent === "root" && location.nodeIndex === 0) ||
    (location.parent === "group" && location.taskIndex === 0)
  ) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }

  if (location.parent === "group") {
    const groupNode = nextView.nodes.find(
      (node) => node.type === "group" && node.group.id === location.groupId,
    );
    if (!groupNode || groupNode.type !== "group") {
      return view;
    }
    const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
    return insertTaskIntoGroup(nextView, task, location.groupId, firstTaskKey);
  }

  return {
    nodes: [{ type: "task", task }, ...nextView.nodes],
  };
}

export {
  areAllGroupedTaskGroupsExpanded,
  cloneView,
  filterGroupedViewByTaskKeys,
  findTaskInGroupedView,
  getGroupedTaskGroupIds,
  moveTaskByMenu,
  moveGroupAroundTopLevelNode,
  moveTaskToTopByMenu,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
  pruneCollapsedGroupedTaskGroupIds,
  removeTaskFromGroupedView,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
};
export type { GroupedTaskInsertPosition };
