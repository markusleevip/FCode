import {
  modelMessageContentToText,
  FCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  FCODE_MCP_ERROR_PRESENTATION_META_KEY,
  FCODE_MCP_NODE_REPL_TRANSIENT_MEDIA_META_KEY,
  FCODE_MCP_CUA_SCREENSHOT_CONTENT_INDICES_META_KEY,
  readCuaScreenshotContentIndices,
  type McpToolCallResult,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@fcode/contracts";
import { asDataUrl, base64PayloadFromMcpImageData } from "./image-normalization.js";

function hasInformativeStructuredContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function formatMcpToolResult(output: unknown): ModelMessageContent {
  if (!isMcpToolCallResult(output)) {
    return stringify(output);
  }

  const captureIndices = readCuaScreenshotContentIndices(output);
  const legacyTransient = output._meta?.[FCODE_MCP_CUA_SCREENSHOT_CONTENT_INDICES_META_KEY] === undefined &&
    output._meta?.[FCODE_MCP_NODE_REPL_TRANSIENT_MEDIA_META_KEY] === true;
  const blocks = output.content.flatMap((block, index) =>
    formatContentBlock(block, legacyTransient || captureIndices.has(index), captureIndices.has(index)));
  if (hasInformativeStructuredContent(output.structuredContent)) {
    blocks.push({
      type: "text",
      text: `Structured content:\n${stringify(output.structuredContent)}`,
    });
  }

  const content = blocks.length > 0 ? collapseModelBlocks(blocks) : stringify(output);
  if (!output.isError) return content;
  const errorPresentation = output._meta?.[FCODE_MCP_ERROR_PRESENTATION_META_KEY];
  return typeof errorPresentation === "string" &&
    errorPresentation === FCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY
    ? content
    : `MCP tool returned an error:\n${modelMessageContentToText(content)}`;
}

function formatContentBlock(
  block: Record<string, unknown>,
  transient: boolean,
  computerUse: boolean,
): ModelMessageContentBlock[] {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    if (typeof block.data === "string" && typeof block.mimeType === "string") {
      return [
        {
          type: "image",
          mediaType: block.mimeType,
          dataUrl: asDataUrl(block.data, block.mimeType),
          source: {
            id: "mcp-image",
            kind: "inline",
            ...(transient ? { retention: "transient" as const } : {}),
            ...(computerUse ? { captureOrigin: "computer_use" as const } : {}),
            mimeType: block.mimeType,
            placeholder: "MCP image",
            sizeBytes: estimateBase64Bytes(block.data),
          },
        },
      ];
    }
    return [{ type: "text", text: `[MCP image content omitted: ${mimeType}]` }];
  }
  if (block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return [{ type: "text", text: `[MCP audio content omitted: ${mimeType}]` }];
  }
  if (block.type === "resource") {
    return [{ type: "text", text: `MCP resource content:\n${stringify(block.resource ?? block)}` }];
  }
  return [{ type: "text", text: stringify(block) }];
}

function collapseModelBlocks(blocks: ModelMessageContentBlock[]): ModelMessageContent {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
  }
  return blocks;
}

function estimateBase64Bytes(value: string): number | undefined {
  const data = base64PayloadFromMcpImageData(value);
  if (data.length === 0) return undefined;
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpToolCallResult).content)
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
