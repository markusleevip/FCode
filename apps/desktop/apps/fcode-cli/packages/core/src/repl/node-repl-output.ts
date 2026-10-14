export interface NodeReplImage {
  base64: string;
  mimeType: string;
}

export interface NodeReplStructuredResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface NodeReplCuaAppIdentity {
  appKey: string;
  displayName?: string;
}

export interface NodeReplWriteSink {
  write(text: string): void;
  images: NodeReplImage[];
  browserScreenshots: NodeReplImage[];
  structuredResults: NodeReplStructuredResult[];
  responseMeta: Record<string, unknown>;
  cuaApps: NodeReplCuaAppIdentity[];
  cuaCaptures: NodeReplImage[];
}

export interface NodeReplRunResult {
  result?: string;
  logs: string;
  error?: { name: string; message: string; stack?: string };
  images?: NodeReplImage[];
  browserScreenshotImageIndices?: number[];
  structuredResults?: NodeReplStructuredResult[];
  responseMeta?: Record<string, unknown>;
  cuaApp?: NodeReplCuaAppIdentity;
  /** Host-only retention state; no screenshot payload is stored here. */
  transientMedia?: true;
  /** Authenticated broker payloads from this cell, never supplied by sandbox code. */
  cuaCaptures?: NodeReplImage[];
}

export type NodeReplRequestMeta = Record<string, unknown>;

export interface NodeReplSessionOptions {
  injectedGlobals?: Record<PropertyKey, unknown> | (() => Record<PropertyKey, unknown>);
  restrictProcess?: boolean;
}

export function browserScreenshotIndexResult(
  images: readonly NodeReplImage[],
  browserScreenshots: readonly NodeReplImage[],
): Pick<NodeReplRunResult, "browserScreenshotImageIndices"> {
  if (images.length === 0 || browserScreenshots.length === 0) return {};

  const remainingByPayload = new Map<string, number>();
  for (const screenshot of browserScreenshots) {
    const key = `${screenshot.mimeType}\u0000${screenshot.base64}`;
    remainingByPayload.set(key, (remainingByPayload.get(key) ?? 0) + 1);
  }

  const browserScreenshotImageIndices: number[] = [];
  images.forEach((image, index) => {
    const key = `${image.mimeType}\u0000${image.base64}`;
    const remaining = remainingByPayload.get(key) ?? 0;
    if (remaining <= 0) return;
    browserScreenshotImageIndices.push(index);
    remainingByPayload.set(key, remaining - 1);
  });
  return browserScreenshotImageIndices.length > 0 ? { browserScreenshotImageIndices } : {};
}

export function latestCuaAppResult(
  cuaApps: readonly NodeReplCuaAppIdentity[],
): Pick<NodeReplRunResult, "cuaApp"> {
  const cuaApp = cuaApps.at(-1);
  return cuaApp ? { cuaApp } : {};
}
