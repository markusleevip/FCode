import { readFCodeStorageItem } from "@fcode/shared/branding-compatibility";
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_SELECTED_EDITOR_STORAGE_KEY = "fcode-last-editor-id";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastSelectedEditorId(
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  const rawValue = storage ? readFCodeStorageItem(storage, LAST_SELECTED_EDITOR_STORAGE_KEY) : null;
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return null;
  }

  return rawValue;
}

export function persistLastSelectedEditorId(
  editorId: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(LAST_SELECTED_EDITOR_STORAGE_KEY, editorId);
}
