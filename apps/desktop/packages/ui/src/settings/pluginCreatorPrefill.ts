import type { SkillSummary } from "@fcode/shared";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";

const PLUGIN_CREATOR_SKILL = "plugin-creator";
const PLUGIN_CREATOR_ID = "plugin-creator@fcode-plugins-official";

function buildPluginCreatorPrefill(skills: readonly SkillSummary[]): CreateTaskOptions {
  // 创建入口只信任官方来源，不让用户目录或同名市场技能截获这项产品动作。
  const skill = skills.find(
    (entry) =>
      entry.name === PLUGIN_CREATOR_SKILL &&
      entry.pluginId === PLUGIN_CREATOR_ID &&
      entry.scope === "plugin" &&
      entry.enabled &&
      entry.path.trim(),
  );
  if (!skill) throw new Error("plugin_creator_unavailable");
  const markdown = buildSkillMentionMarkdown(skill.name, skill.path);
  return {
    initialPrompt: `${markdown} `,
    initialPromptMention: {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      value: skill.name,
      markdown,
      description: skill.description,
      data: { path: skill.path, scope: skill.scope },
    },
  };
}

export async function loadPluginCreatorPrefill(
  loadSkills: () => Promise<{ skills: SkillSummary[] }>,
  isCurrent: () => boolean,
  ensureAvailable?: () => Promise<void>,
): Promise<CreateTaskOptions | null> {
  let result = await loadSkills();
  if (!isCurrent()) return null;
  // 精简安装没有随包创建器；首次创建走现有官方安装服务，显式停用的技能不自动重开。
  if (!result.skills.some((skill) => skill.pluginId === PLUGIN_CREATOR_ID) && ensureAvailable) {
    await ensureAvailable();
    if (!isCurrent()) return null;
    result = await loadSkills();
  }
  return isCurrent() ? buildPluginCreatorPrefill(result.skills) : null;
}
