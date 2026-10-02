import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@fcode/provider";
import { NodeFCodeBuiltinProviderConfigSource } from "./fcode-builtin-provider-config-source.js";
import {
  EndpointScopedFCodeBuiltinSource,
  type EndpointScopedFCodeBuiltinSourceOptions,
} from "./endpoint-scoped-fcode-builtin-source.js";
import {
  FCodeBuiltinRemoteSynchronizer,
  type FCodeBuiltinRemoteSynchronizerOptions,
  type FCodeBuiltinRefreshResult,
} from "./fcode-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly fcodeBuiltinFilePath: string;
  readonly fcodeBuiltinActiveFilePath?: string;
  readonly fcodeBuiltinRemote?: Omit<FCodeBuiltinRemoteSynchronizerOptions, "source">;
  readonly fcodeBuiltinEnvironment?: Omit<
    EndpointScopedFCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onFCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    fcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 FCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #fcodeBuiltinSource:
    | NodeFCodeBuiltinProviderConfigSource
    | EndpointScopedFCodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: FCodeBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#fcodeBuiltinSource = options.fcodeBuiltinEnvironment
      ? new EndpointScopedFCodeBuiltinSource({
          bundledFilePath: options.fcodeBuiltinFilePath,
          ...options.fcodeBuiltinEnvironment,
        })
      : new NodeFCodeBuiltinProviderConfigSource({
          bundledFilePath: options.fcodeBuiltinFilePath,
          activeFilePath: options.fcodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.fcodeBuiltinRemote &&
      this.#fcodeBuiltinSource instanceof NodeFCodeBuiltinProviderConfigSource
        ? new FCodeBuiltinRemoteSynchronizer({
            source: this.#fcodeBuiltinSource,
            ...options.fcodeBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onFCodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#fcodeBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      fcodeBuiltinSource: this.#fcodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveFCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#fcodeBuiltinSource instanceof NodeFCodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#fcodeBuiltinSource.activeFilePath)
      : this.#fcodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@fcode/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckFCodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#fcodeBuiltinSource instanceof EndpointScopedFCodeBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshFCodeBuiltin(options?: { readonly force?: boolean }): Promise<FCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#fcodeBuiltinSource instanceof EndpointScopedFCodeBuiltinSource) {
      return this.#fcodeBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshFCodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#fcodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
