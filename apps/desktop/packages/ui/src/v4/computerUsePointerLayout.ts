import type { ComputerUsePanelState } from "@fcode/shared";

/** object-contain positions include letterboxing; the pointer tip is the anchor. */
export function computerUsePointerLayout(state: ComputerUsePanelState, box: { width: number; height: number }, now: number) {
  const geometry = state.previewGeometry, pointer = state.operationPointer;
  if (state.status !== "active" || state.previewFailed || !geometry || !pointer ||
      pointer.previewRevision !== geometry.revision || pointer.updatedAt > now || pointer.expiresAt <= now ||
      ![box.width, box.height, pointer.x, pointer.y].every(Number.isFinite) || box.width <= 0 || box.height <= 0 ||
      pointer.x < 0 || pointer.y < 0 || pointer.x >= geometry.width || pointer.y >= geometry.height) return undefined;
  const scale = Math.min(box.width / geometry.width, box.height / geometry.height);
  return { left: (box.width - geometry.width * scale) / 2 + pointer.x * scale,
    top: (box.height - geometry.height * scale) / 2 + pointer.y * scale };
}
