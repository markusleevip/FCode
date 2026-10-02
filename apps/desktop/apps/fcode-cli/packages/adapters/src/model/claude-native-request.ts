// Claude OAuth wire constraints adapted from CLIProxyAPI (MIT).
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";
import { CLAUDE_NATIVE_ACCOUNT_HEADER } from "@fcode/shared";
import { messagesRecord as record } from "./messages-native-stream.js";
import { createClaudeToolSymbols } from "./claude-native-tools.js";
import { createClaudeEventNormalizer } from "./claude-native-events.js";

type JsonRecord = Record<string, unknown>;
const CLAUDE_BASE_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const CONTEXT_BETA = "context-1m-2025-08-07";
const THINKING_BETA = "interleaved-thinking-2025-05-14";
const EFFORT_BETA = "effort-2025-11-24";
const CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";
const CONTEXT_SUFFIX = "[1m]";

export function prepareClaudeNativeRequest(body: JsonRecord, headers: Headers) {
  const next = structuredClone(body);
  const accountId = headers.get(CLAUDE_NATIVE_ACCOUNT_HEADER);
  // 内部账号头只传递 Host 已校验的身份，不能送到厂商或让配置中的旧账号覆盖它。
  headers.delete(CLAUDE_NATIVE_ACCOUNT_HEADER);
  if (accountId !== null) {
    const metadata = record(next.metadata) ?? {};
    let identity: JsonRecord = {};
    if (metadata.user_id !== undefined) {
      try {
        identity = record(JSON.parse(String(metadata.user_id))) ?? {};
      } catch {
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelRequest,
          "Claude account metadata must use the native identity format",
        );
      }
    }
    next.metadata = {
      ...metadata,
      user_id: JSON.stringify({ ...identity, account_uuid: accountId }),
    };
  }
  const betas = new Set(CLAUDE_BASE_BETAS);
  for (const beta of (headers.get("anthropic-beta") ?? "").split(","))
    if (beta.trim()) betas.add(beta.trim());
  if (next.betas !== undefined) {
    if (
      !Array.isArray(next.betas) ||
      next.betas.some((beta) => typeof beta !== "string" || !beta.trim())
    )
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "Claude request betas must be strings",
      );
    for (const beta of next.betas as string[]) betas.add(beta.trim());
    delete next.betas;
  }
  if (typeof next.model === "string" && next.model.toLowerCase().endsWith(CONTEXT_SUFFIX)) {
    next.model = next.model.slice(0, -CONTEXT_SUFFIX.length);
    betas.add(CONTEXT_BETA);
  }
  const forced = ["any", "tool"].includes(String(record(next.tool_choice)?.type));
  const output = record(next.output_config);
  if (forced) {
    delete next.thinking;
    if (output) {
      delete output.effort;
      if (!Object.keys(output).length) delete next.output_config;
    }
  }
  const thinking = record(next.thinking);
  const active = ["enabled", "adaptive", "auto"].includes(String(thinking?.type));
  if (active) {
    betas.add(THINKING_BETA);
    if (next.temperature !== undefined && next.temperature !== 1) delete next.temperature;
    if (typeof next.top_p === "number" && next.top_p < 0.95) delete next.top_p;
    delete next.top_k;
    if (thinking?.type === "enabled") {
      const budget = thinking.budget_tokens;
      if (
        typeof budget !== "number" ||
        !Number.isSafeInteger(budget) ||
        budget < 1024 ||
        (typeof next.max_tokens === "number" && budget >= next.max_tokens)
      )
        throw new ModelProtocolError(
          ModelErrorCode.InvalidModelRequest,
          "Claude thinking budget must be at least 1024 and less than max_tokens",
        );
    }
  } else if (next.temperature !== undefined && next.top_p !== undefined) delete next.top_p;
  if (!forced && output?.effort !== undefined) betas.add(EFFORT_BETA);
  if (Array.isArray(next.tools))
    next.tools = next.tools.map((value) => {
      const tool = record(value);
      if (!tool || !String(tool.type ?? "").startsWith("web_search_")) return value;
      for (const field of ["allowed_domains", "blocked_domains"])
        if (Array.isArray(tool[field]) && tool[field].length === 0) delete tool[field];
      return tool;
    });
  // 只检查协议 cache_control，不递归用户 schema/input/result。
  const ttl = (value: unknown) => record(record(value)?.cache_control)?.ttl === "1h";
  const nodes = [
    ...(Array.isArray(next.tools) ? next.tools : []),
    ...(Array.isArray(next.system) ? next.system : []),
  ];
  if (Array.isArray(next.messages))
    for (const turn of next.messages) {
      const content = record(turn)?.content;
      if (Array.isArray(content)) nodes.push(...content);
    }
  if (nodes.some(ttl)) betas.add(CACHE_TTL_BETA);
  headers.set("anthropic-beta", [...betas].join(","));
  headers.set("anthropic-version", "2023-06-01");
  headers.set("x-app", "cli");
  const symbols = createClaudeToolSymbols(next);
  return { ...symbols, restoreEvent: createClaudeEventNormalizer(symbols.restoreEvent) };
}

export function claudeMessagesUrl(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  url.searchParams.set("beta", "true");
  return url.toString();
}
