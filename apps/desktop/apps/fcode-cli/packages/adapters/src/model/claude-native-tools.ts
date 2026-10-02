// Request-local OAuth MCP symbols adapted from CLIProxyAPI (MIT).
import { createHash } from "node:crypto";
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import { messagesRecord as record } from "./messages-native-stream.js";

type JsonRecord = Record<string, unknown>;
const ALIAS_PREFIX = "mcp__fcode__";
const MAX_TOOL_NAME_LENGTH = 64;
const MCP_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const SERVER_TOOL_TYPE =
  /^(?:advisor|agent_toolset|bash|code_execution|computer|memory|text_editor|tool_search_tool|web_fetch|web_search)_/;

function protocolError(message: string, response = false): never {
  throw new ModelProtocolError(
    response ? ModelErrorCode.InvalidModelResponse : ModelErrorCode.InvalidModelRequest,
    message,
  );
}

export function createClaudeToolSymbols(body: JsonRecord): {
  body: JsonRecord;
  restoreMessage(value: JsonRecord): JsonRecord;
  restoreEvent(value: JsonRecord): JsonRecord;
} {
  const tools = Array.isArray(body.tools) ? body.tools.map(record) : [];
  const reserved = new Set(
    tools.map((tool) => tool?.name).filter((name): name is string => typeof name === "string"),
  );
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim())
      protocolError("Claude tool requires a name");
    const name = tool.name;
    if (SERVER_TOOL_TYPE.test(String(tool.type ?? ""))) continue;
    if (forward.has(name)) protocolError("Claude request declares a duplicate client tool name");
    if (MCP_NAME.test(name) && name.length <= MAX_TOOL_NAME_LENGTH) {
      forward.set(name, name);
      reverse.set(name, name);
      continue;
    }
    const semantic = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const digest = createHash("sha256").update(name).digest("hex");
    let alias: string | undefined;
    for (let attempt = 0; attempt < MAX_TOOL_NAME_LENGTH; attempt++) {
      const suffix = `_${digest.slice(0, 12)}${attempt ? `_${attempt}` : ""}`;
      const candidate =
        ALIAS_PREFIX +
        semantic.slice(0, MAX_TOOL_NAME_LENGTH - ALIAS_PREFIX.length - suffix.length) +
        suffix;
      if (!reserved.has(candidate)) {
        alias = candidate;
        break;
      }
    }
    if (!alias) protocolError("Claude request cannot allocate a unique tool alias");
    reserved.add(alias);
    forward.set(name, alias);
    reverse.set(alias, name);
  }
  const outgoing = (name: unknown): unknown =>
    typeof name === "string" ? (forward.get(name) ?? name) : name;
  const incoming = (name: unknown): unknown => {
    if (typeof name !== "string") return name;
    const restored = reverse.get(name);
    if (restored) return restored;
    if (name.startsWith(ALIAS_PREFIX))
      protocolError("Claude response contains an unknown tool alias", true);
    return name;
  };

  // 只转换协议中明确命名工具的节点；schema、input、工具结果正文和签名都是用户/厂商数据。
  function block(value: unknown, rename: (name: unknown) => unknown): unknown {
    const part = record(value);
    if (!part) return value;
    const next = { ...part };
    if (next.type === "tool_use") next.name = rename(next.name);
    if (next.type === "tool_reference") next.tool_name = rename(next.tool_name);
    if (next.type === "tool_result" && Array.isArray(next.content))
      next.content = next.content.map((part) => block(part, rename));
    if (next.type === "tool_search_tool_result") {
      const content = record(next.content);
      if (content && Array.isArray(content.tool_references))
        next.content = {
          ...content,
          tool_references: content.tool_references.map((part) => block(part, rename)),
        };
    }
    if (next.type === "tool_addition" || next.type === "tool_removal") {
      const tool = record(next.tool);
      if (tool && !SERVER_TOOL_TYPE.test(String(tool.type ?? ""))) {
        const definition = record(tool.definition);
        next.tool = definition
          ? { ...tool, definition: { ...definition, name: rename(definition.name) } }
          : { ...tool, name: rename(tool.name) };
      }
    }
    return next;
  }
  function message(value: JsonRecord, rename: (name: unknown) => unknown): JsonRecord {
    return Array.isArray(value.content)
      ? { ...value, content: value.content.map((part) => block(part, rename)) }
      : value;
  }
  const next = { ...body };
  if (Array.isArray(body.tools))
    next.tools = tools.map((tool) => {
      if (!tool || SERVER_TOOL_TYPE.test(String(tool.type ?? ""))) return tool;
      const converted: JsonRecord = { ...tool, name: outgoing(tool.name) };
      delete converted.type;
      return converted;
    });
  const choice = record(body.tool_choice);
  if (choice?.type === "tool") next.tool_choice = { ...choice, name: outgoing(choice.name) };
  if (Array.isArray(body.messages))
    next.messages = body.messages.map((value) => {
      const turn = record(value);
      return turn ? message(turn, outgoing) : value;
    });
  return {
    body: next,
    restoreMessage: (value) => message(value, incoming),
    restoreEvent(value) {
      const part = record(value.content_block);
      const start = record(value.message);
      return {
        ...value,
        ...(part ? { content_block: block(part, incoming) } : {}),
        ...(start ? { message: message(start, incoming) } : {}),
      };
    },
  };
}
