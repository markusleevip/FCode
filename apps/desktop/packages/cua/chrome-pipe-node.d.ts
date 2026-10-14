import type { spawn } from "node:child_process";

/** Host-only transport. The model's Computer Use SDK does not expose this object. */
export declare class CuaChromePipe {
  private constructor();
  static start(options: { executablePath: string; cacheDirectory: string; spawnProcess?: typeof spawn }): Promise<CuaChromePipe>;
  readonly pid: number | undefined;
  readonly running: boolean;
  onTargetCreated(listener: (target: { targetId: string; type: string }) => void): () => void;
  request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string, params?: Record<string, unknown>, sessionId?: string, signal?: AbortSignal, timeoutMs?: number,
  ): Promise<T>;
  close(): Promise<void>;
}
