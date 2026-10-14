import {
  FCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  FCODE_MCP_NODE_REPL_TRANSIENT_MEDIA_META_KEY,
  nodeReplCuaAppDisplaySchema,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@fcode/contracts";
import { isRecord } from "./utils.js";

export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  // The host strips sandbox-authored associations; only its dedicated identity is projected.
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[FCODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

export function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const preferLatest = meta?.[FCODE_MCP_NODE_REPL_TRANSIENT_MEDIA_META_KEY] === true;
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      if (!preferLatest) continue;
      // A capture-input-capture cell must not fill the bounded preview with pre-input frames.
      images.shift();
    }
    images.push({ base64, mimeType });
  }

  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}
