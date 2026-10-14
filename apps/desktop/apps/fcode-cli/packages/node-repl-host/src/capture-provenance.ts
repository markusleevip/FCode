import type { NodeReplRunResult } from "@fcode/core/repl";

/** Match output occurrences to authenticated captures, without trusting sandbox metadata. */
export function cuaScreenshotContentIndices(
  content: readonly { type: string; data?: unknown; mimeType?: unknown }[],
  captures: NodeReplRunResult["cuaCaptures"],
): number[] {
  const remaining = [...(captures ?? [])];
  const indices: number[] = [];
  content.forEach((block, index) => {
    if (block.type !== "image") return;
    const captureIndex = remaining.findIndex((image) =>
      image.base64 === block.data && image.mimeType === block.mimeType);
    if (captureIndex < 0) return;
    remaining.splice(captureIndex, 1);
    indices.push(index);
  });
  return indices;
}
