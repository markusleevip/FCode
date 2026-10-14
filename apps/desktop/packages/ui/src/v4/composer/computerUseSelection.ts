import { COMPUTER_USE_PLUGIN_ID } from "@fcode/shared";

/** Read only the frozen visible editor nodes, never the serialized prompt text. */
export function hasComputerUseSelection(editorStateJson: string | undefined): boolean {
  if (!editorStateJson) return false;
  let value: unknown;
  try { value = JSON.parse(editorStateJson); } catch { return false; }
  if (!value || typeof value !== "object" || !("root" in value)) return false;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 32 || !node || typeof node !== "object" || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    if (record.type === "quote" || record.type === "code" || record.type === "code-highlight") return false;
    if (record.type === "prompt-mention" && record.version === 1 && record.category === "skills" &&
        record.value === "computer-use" && typeof record.mentionId === "string" && record.mentionId.startsWith("skill:")) {
      const data = record.data;
      return Boolean(data && typeof data === "object" && !Array.isArray(data) &&
        (data as Record<string, unknown>).scope === "plugin" &&
        (data as Record<string, unknown>).pluginId === COMPUTER_USE_PLUGIN_ID);
    }
    if (record.type === "prompt-mention" && record.version === 1 && record.category === "plugins" &&
        record.value === COMPUTER_USE_PLUGIN_ID && record.mentionId === `plugin:${COMPUTER_USE_PLUGIN_ID}`) {
      const data = record.data;
      return Boolean(data && typeof data === "object" && !Array.isArray(data) &&
        (data as Record<string, unknown>).pluginId === COMPUTER_USE_PLUGIN_ID);
    }
    return Array.isArray(record.children) && record.children.some((child) => visit(child, depth + 1));
  };
  return visit((value as Record<string, unknown>).root, 0);
}
