// Tool declaration adaptation from CLIProxyAPI Gemini translators (MIT).
import { createHash } from "node:crypto";
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
export type NativeRecord = Record<string, unknown>;
export type GeminiNativeSupplier = "antigravity" | "vertex";
export function geminiRecord(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as NativeRecord)
    : undefined;
}
export function geminiFailure(message: string, request = false): never {
  throw new ModelProtocolError(
    request ? ModelErrorCode.InvalidModelRequest : ModelErrorCode.InvalidModelResponse,
    `Native Gemini ${message}`,
  );
}
function schema(value: unknown, root: NativeRecord, depth = 0): NativeRecord {
  const input = geminiRecord(value);
  if (!input || depth > 64) geminiFailure("tool schema is invalid or recursive", true);
  if (input.$ref !== undefined) {
    if (typeof input.$ref !== "string" || !input.$ref.startsWith("#/"))
      geminiFailure("requires local tool schema references", true);
    let target: unknown = root;
    for (const key of input.$ref.slice(2).split("/"))
      target = geminiRecord(target)?.[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!geminiRecord(target)) geminiFailure("tool schema reference is unresolved", true);
    const { $ref: _ref, ...siblings } = input;
    return schema({ ...geminiRecord(target), ...siblings }, root, depth + 1);
  }
  const result: NativeRecord = {};
  const hints: string[] = [];
  for (const [key, item] of Object.entries(input)) {
    // Antigravity 私有工具 Schema 不接受这些标准约束；保留描述提示，执行端仍校验原声明。
    if (
      [
        "minLength",
        "maxLength",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minimum",
        "maximum",
        "multipleOf",
        "pattern",
        "format",
        "minItems",
        "maxItems",
        "uniqueItems",
        "contains",
      ].includes(key)
    ) {
      hints.push(`${key}=${JSON.stringify(item)}`);
      continue;
    }
    // 只处理声明中的 schema；历史工具参数和结果中的同名字段不得改写。
    if (
      [
        "$schema",
        "$id",
        "$defs",
        "definitions",
        "title",
        "default",
        "examples",
        "additionalProperties",
        // 私有 Gemini 后端会拒绝对象键约束；只移除 schema 关键字，保留 properties 中的同名属性。
        "propertyNames",
        "patternProperties",
      ].includes(key)
    )
      continue;
    if (key === "properties") {
      const fields = geminiRecord(item);
      if (!fields) geminiFailure("tool properties are invalid", true);
      result[key] = Object.fromEntries(
        Object.entries(fields).map(([name, child]) => [name, schema(child, root, depth + 1)]),
      );
    } else if (key === "items") result[key] = schema(item, root, depth + 1);
    else if (["anyOf", "oneOf", "allOf"].includes(key)) {
      if (!Array.isArray(item)) geminiFailure("tool schema variants are invalid", true);
      result[key] = item.map((child) => schema(child, root, depth + 1));
    } else if (key === "const") result.enum = [item];
    else result[key] = item;
  }
  if (hints.length)
    result.description = [
      typeof result.description === "string" ? result.description : "",
      `Constraints: ${hints.join("; ")}.`,
    ]
      .filter(Boolean)
      .join("\n");
  return result;
}
export function geminiNativeTools(body: NativeRecord, supplier: GeminiNativeSupplier) {
  const aliases = new Map<string, string>(),
    originals = new Map<string, string>();
  const declarations: NativeRecord[] = [],
    hosted: NativeRecord[] = [];
  if (body.tools !== undefined && !Array.isArray(body.tools))
    geminiFailure("tools must be an array", true);
  for (const entry of (body.tools ?? []) as unknown[]) {
    const tool = geminiRecord(entry);
    if (!tool) geminiFailure("tool declaration is invalid", true);
    if (typeof tool.type === "string" && tool.type.startsWith("web_search")) {
      hosted.push({ googleSearch: {} });
      continue;
    }
    if (tool.type && tool.type !== "custom") geminiFailure("tool kind is unsupported", true);
    if (typeof tool.name !== "string" || !tool.name || aliases.has(tool.name))
      geminiFailure("tool name is missing or duplicate", true);
    let alias = tool.name;
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(alias))
      alias = `fcode_${alias.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}_${createHash("sha256").update(alias).digest("hex").slice(0, 12)}`;
    if (originals.has(alias)) geminiFailure("tool names collide", true);
    aliases.set(tool.name, alias);
    originals.set(alias, tool.name);
    const input = geminiRecord(tool.input_schema);
    if (!input) geminiFailure("tool schema is missing", true);
    declarations.push({
      name: alias,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(supplier === "vertex"
        ? { parametersJsonSchema: structuredClone(input) }
        : { parameters: schema(input, input) }),
    });
  }
  return {
    tools: [...(declarations.length ? [{ functionDeclarations: declarations }] : []), ...hosted],
    alias(name: string) {
      const result = aliases.get(name);
      if (!result) geminiFailure("history or choice references an undeclared tool", true);
      return result;
    },
    original(name: string) {
      const result = originals.get(name);
      if (!result) geminiFailure("response references an undeclared tool");
      return result;
    },
  };
}
