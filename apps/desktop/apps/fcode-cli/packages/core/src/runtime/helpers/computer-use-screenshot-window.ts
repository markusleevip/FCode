import type { ModelInputMessage, RuntimeMessageEntry } from "../../agent/message-history.js";
import { isRuntimeAttachmentEntry } from "../../agent/message-history.js";
import { officialCuaImageRefIndexesForUnavailableMedia } from "./official-cua-media.js";

export const COMPUTER_USE_SCREENSHOT_WINDOW = 3;
const OMITTED_OBSERVATION_TEXT = "Earlier computer screenshots omitted. Observe again before input.";

export interface ScreenshotWindowDiagnostics {
  capturedBefore: number;
  capturedAfter: number;
  removed: number;
  userImages: number;
  imageBytesBefore: number;
  imageBytesAfter: number;
}

/** User attachments and ordinary generated images never enter the capture window. */
export function projectComputerUseScreenshots<T extends ModelInputMessage>(messages: readonly T[]): {
  messages: T[];
  diagnostics: ScreenshotWindowDiagnostics;
} {
  let remaining = COMPUTER_USE_SCREENSHOT_WINDOW;
  const diagnostics: ScreenshotWindowDiagnostics = {
    capturedBefore: 0, capturedAfter: 0, removed: 0, userImages: 0,
    imageBytesBefore: 0, imageBytesAfter: 0,
  };
  let changed = false;
  const projected = [...messages];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]!;
    if (!Array.isArray(message.content)) continue;
    const removedIndices = new Set<number>();
    for (let index = message.content.length - 1; index >= 0; index--) {
      const block = message.content[index]!;
      if (block.type !== "image") continue;
      const bytes = block.dataUrl.length;
      diagnostics.imageBytesBefore += bytes;
      if (message.role === "user") diagnostics.userImages++;
      const captured = message.role === "tool" && block.source?.captureOrigin === "computer_use";
      if (captured) {
        diagnostics.capturedBefore++;
        if (remaining-- <= 0) {
          removedIndices.add(index);
          diagnostics.removed++;
          continue;
        }
        diagnostics.capturedAfter++;
      }
      diagnostics.imageBytesAfter += bytes;
    }
    if (!removedIndices.size) continue;
    const refs = officialCuaImageRefIndexesForUnavailableMedia(message.content, removedIndices);
    const content = message.content.filter((_, index) => !removedIndices.has(index) && !refs.has(index));
    projected[messageIndex] = { ...message, content: content.length ? content : OMITTED_OBSERVATION_TEXT };
    changed = true;
  }
  return { messages: changed ? projected : messages as T[], diagnostics };
}

export function projectComputerUseScreenshotEntries(entries: readonly RuntimeMessageEntry[]): {
  entries: RuntimeMessageEntry[];
  diagnostics: ScreenshotWindowDiagnostics;
} {
  const messages = entries.filter((entry) => !isRuntimeAttachmentEntry(entry)).map((entry) => entry.message);
  const projection = projectComputerUseScreenshots(messages);
  if (!projection.diagnostics.removed) return { entries: entries as RuntimeMessageEntry[], diagnostics: projection.diagnostics };
  let index = 0;
  return {
    entries: entries.map((entry) => isRuntimeAttachmentEntry(entry) ? entry :
      { ...entry, message: projection.messages[index++]! }),
    diagnostics: projection.diagnostics,
  };
}
