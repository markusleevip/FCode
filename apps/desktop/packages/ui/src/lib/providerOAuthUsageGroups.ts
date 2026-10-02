import type { ProviderOAuthUsageWindow } from "@fcode/services";

export type ProviderOAuthUsageFamily = "gemini" | "claude-gpt" | "other";

export interface ProviderOAuthUsageGroup {
  readonly id: string;
  /** 模型型额度（Antigravity）按家族分组；窗口型额度（Codex）没有家族。 */
  readonly family?: ProviderOAuthUsageFamily;
  /** 家族内的模型系列名，如 Gemini Flash、Claude Opus；用于“此分组包含”。 */
  readonly members: readonly string[];
  readonly windowIds: readonly string[];
  readonly windowSeconds?: number;
  readonly usedPercent: number;
  readonly resetsAt?: number;
}

function familyOf(window: ProviderOAuthUsageWindow): ProviderOAuthUsageFamily {
  const name = `${window.id} ${window.label ?? ""}`.toLowerCase();
  if (name.includes("gemini")) return "gemini";
  if (/claude|gpt/.test(name)) return "claude-gpt";
  return "other";
}

/** “Gemini 3.5 Flash (Medium)” → “Gemini Flash”；“gemini-3.6-flash-tiered” → “Gemini Flash”。 */
export function usageSeriesName(window: ProviderOAuthUsageWindow): string {
  const raw = (window.label ?? window.id).replace(/\([^)]*\)/g, " ").trim();
  const tokens = (/\s/.test(raw) ? raw.split(/\s+/) : raw.split(/[-_]/)).filter(
    (token) => token && !/^\d/.test(token),
  );
  // 只有 id 形式（全小写）的词才补首字母大写；GPT-OSS 这类已有大小写的名称保持原样。
  const name = tokens
    .slice(0, 2)
    .map((token) =>
      token === token.toLowerCase() ? token[0]!.toUpperCase() + token.slice(1) : token,
    )
    .join(" ");
  return name || (window.label ?? window.id);
}

/**
 * 同家族共享额度桶：已用比例取成员最大值，重置时间取该成员的重置时间。
 * 窗口型额度（无模型名）保持逐个窗口，不合并。
 */
export function groupUsageWindows(
  windows: readonly ProviderOAuthUsageWindow[],
): readonly ProviderOAuthUsageGroup[] {
  const groups = new Map<
    string,
    {
      family?: ProviderOAuthUsageFamily;
      members: string[];
      windowIds: string[];
      top: ProviderOAuthUsageWindow;
    }
  >();
  for (const window of windows) {
    const family = window.label ? familyOf(window) : undefined;
    const key = family ? `f|${family}` : `w|${window.id}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...(family ? { family, members: [usageSeriesName(window)] } : { members: [] }),
        windowIds: [window.id],
        top: window,
      });
      continue;
    }
    group.windowIds.push(window.id);
    if (family) {
      const series = usageSeriesName(window);
      if (!group.members.includes(series)) group.members.push(series);
    }
    if (window.usedPercent > group.top.usedPercent) group.top = window;
  }
  return [...groups.entries()].map(([key, { family, members, windowIds, top }]) => ({
    id: key,
    ...(family ? { family } : {}),
    members,
    windowIds,
    usedPercent: top.usedPercent,
    ...(top.windowSeconds !== undefined ? { windowSeconds: top.windowSeconds } : {}),
    ...(top.resetsAt !== undefined ? { resetsAt: top.resetsAt } : {}),
  }));
}

/** 当前模型所在的组排最前；其余保持上游顺序。 */
export function splitCurrentUsageGroup(
  groups: readonly ProviderOAuthUsageGroup[],
  currentModelId: string | undefined,
): { current?: ProviderOAuthUsageGroup; others: readonly ProviderOAuthUsageGroup[] } {
  const current = currentModelId
    ? groups.find((group) => group.windowIds.includes(currentModelId))
    : undefined;
  return { ...(current ? { current } : {}), others: groups.filter((group) => group !== current) };
}
