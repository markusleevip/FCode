import type { Event } from "@fcode/rpc";
import { ServiceChannels } from "@fcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ProviderSettingsProviderView,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@fcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import {
  CODEX_CLIENT_ONLY_REASONING_LEVELS,
  type ProviderOAuthModel,
} from "../provider-oauth/contract.js";
import type { ModelConnectivityResult } from "@fcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  fetchProviderModelIds,
  resolveModelCatalogUrl,
  type ProviderModelCatalogApiType,
} from "./providerModelCatalog.js";

const catalogLogger = createServiceLogger("provider-model-catalog");

export type ProviderOAuthModelCatalogResolver = (
  access: Extract<NonNullable<ProviderConfigObject["access"]>, { type: "provider-oauth" }>,
) => Promise<readonly ProviderOAuthModel[]>;

function formatCatalogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 启动期补偿：已配置端点与密钥但模型列表为空的 Provider，静默补拉一次网关模型目录。 */
export async function syncEmptyModelCatalogs(
  facade: ProviderSettingsFacade,
  resolveOAuthModels?: ProviderOAuthModelCatalogResolver,
): Promise<void> {
  let view: ProviderSettingsView;
  try {
    view = facade.getView();
  } catch {
    return;
  }
  for (const provider of view.providers) {
    const access = provider.effectiveConfig.access;
    // 旧账号已保存成员也会丢失 Codex 能力；只补偿仍使用通用开关的模型，复用目录同步入口。
    const legacyCodex =
      access?.type === "provider-oauth" &&
      access.supplier === "codex" &&
      provider.models.some((model) => {
        const values = model.effectiveConfig.optionSpecs?.reasoningLevel?.values;
        // 旧目录可能已保存客户端专属档位（如 ultra），API 会以 400 拒绝；启动时重新同步清除。
        return (
          !values ||
          values.some(
            (value) =>
              value === "enabled" ||
              value === "none" ||
              CODEX_CLIENT_ONLY_REASONING_LEVELS.includes(value),
          )
        );
      });
    if (provider.models.length > 0 && !legacyCodex) continue;
    try {
      await refreshProviderModelCatalog(facade, provider.providerId, resolveOAuthModels);
      catalogLogger.info(undefined, `[startup] ${provider.providerId} 已同步模型目录与能力`);
    } catch (error) {
      // 启动期网络不可达是常态（离线/网关临时故障）；只记 debug，用户保存端点或手动刷新时会再触发。
      catalogLogger.debug(
        undefined,
        `[startup] ${provider.providerId} 补拉网关模型目录失败: ${formatCatalogError(error)}`,
      );
    }
  }
}

function resolveAccessApiKey(config: ProviderConfigObject | undefined): string | null | undefined {
  return config?.access?.type === "api-key" ? config.access.apiKey : undefined;
}

/** 端点事实（api 类型、baseUrl、凭据）是否发生变化；变化才值得重新拉取模型目录。 */
function hasModelCatalogEndpointChange(
  previous: ProviderSettingsView,
  next: ProviderSettingsView,
  providerId: ProviderId,
): boolean {
  const before = previous.providers.find((item) => item.providerId === providerId)?.effectiveConfig;
  const after = next.providers.find((item) => item.providerId === providerId)?.effectiveConfig;
  return (
    before?.api?.type !== after?.api?.type ||
    before?.api?.baseUrl !== after?.api?.baseUrl ||
    before?.access?.type !== after?.access?.type ||
    resolveAccessApiKey(before) !== resolveAccessApiKey(after)
  );
}

function resolveModelCatalogEndpoint(provider: ProviderSettingsProviderView): {
  apiType: ProviderModelCatalogApiType;
  baseUrl: string;
  apiKey: string;
} {
  const { api, access } = provider.effectiveConfig;
  if (access?.type !== "api-key" || !access.apiKey?.trim()) {
    throw new Error(
      `Provider ${provider.providerId} 未配置 plain api-key access，无法拉取模型目录`,
    );
  }
  if (!api?.type || !api.baseUrl?.trim()) {
    throw new Error(
      `Provider ${provider.providerId} 缺少 api.type 或 api.baseUrl，无法拉取模型目录`,
    );
  }
  return { apiType: api.type, baseUrl: api.baseUrl, apiKey: access.apiKey.trim() };
}

/**
 * 按 Provider 当前 effectiveConfig（baseUrl + apiKey）实时拉取网关模型列表，
 * 并用返回结果整体替换该 Provider 的 Personal 模型成员。
 */
export async function refreshProviderModelCatalog(
  facade: ProviderSettingsFacade,
  providerId: ProviderId,
  resolveOAuthModels?: ProviderOAuthModelCatalogResolver,
): Promise<ProviderSettingsView> {
  const view = facade.getView();
  const provider = view.providers.find((item) => item.providerId === providerId);
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
  if (provider.effectiveConfig.access?.type === "provider-oauth") {
    if (!resolveOAuthModels) throw new Error("当前 Host 未装配供应商账号模型目录");
    const access = provider.effectiveConfig.access;
    const models = await resolveOAuthModels(access);
    const modelIds = models.map((model) => model.id);
    if (!modelIds.length) throw new Error("供应商账号未返回可用的对话模型");
    // 查询期间配置可能已改绑或删除；旧账号目录不能覆盖当前 Provider 的成员。
    const current = facade.getView().providers.find((item) => item.providerId === providerId)
      ?.effectiveConfig.access;
    if (
      current?.type !== "provider-oauth" ||
      current.accountId !== access.accountId ||
      current.supplier !== access.supplier
    )
      throw new Error("供应商账号绑定已发生变化，请重新获取模型");
    // 仅写入目录明确提供的叶子；未声明的能力继续继承内置规则，不被默认值覆盖。
    const modelConfigs = Object.fromEntries(
      models.flatMap((model) => {
        const reasoningLevels = access.supplier === "codex" ? model.reasoningLevels : undefined;
        const properties =
          model.supportsImage !== undefined
            ? { properties: { inputFormat: { supportsImage: model.supportsImage } } }
            : {};
        const optionSpecs = reasoningLevels
          ? {
              optionSpecs: {
                reasoningLevel: {
                  values: [...reasoningLevels],
                  map: '{"reasoning":{"effort":reasoningLevel}}',
                },
              },
            }
          : {};
        return reasoningLevels || model.supportsImage !== undefined
          ? [[model.id, { ...properties, ...optionSpecs }]]
          : [];
      }),
    );
    return facade.replacePersonalProviderModelIds(providerId, modelIds, {
      basedOnRevision: view.revision,
      modelConfigs,
    });
  }
  const endpoint = resolveModelCatalogEndpoint(provider);
  const modelIds = await fetchProviderModelIds(endpoint);
  if (modelIds.length === 0) {
    throw new Error(
      `网关未返回可用的对话模型 (${resolveModelCatalogUrl(endpoint.baseUrl, endpoint.apiType)})`,
    );
  }
  return facade.replacePersonalProviderModelIds(providerId, modelIds);
}

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@fcode/provider";

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  /** 按当前 baseUrl + apiKey 实时拉取网关模型列表并整体替换成员；失败抛错由调用方降级。 */
  refreshProviderModelIds(providerId: ProviderId): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  resolveOAuthModels?: ProviderOAuthModelCatalogResolver,
): IProviderSettingsService {
  return {
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      const created = await facade.createPersonalProvider(input);
      const apiKey =
        input?.initialConfig?.access?.type === "api-key"
          ? input.initialConfig.access.apiKey
          : undefined;
      if (!apiKey?.trim()) return created;
      // 创建后立即按真实网关模型目录回填成员；失败不阻断创建，回落到模板 builtin 列表。
      try {
        return {
          providerId: created.providerId,
          view: await refreshProviderModelCatalog(facade, created.providerId),
        };
      } catch (error) {
        catalogLogger.warn(
          undefined,
          `[createPersonalProvider] ${created.providerId} 拉取网关模型目录失败，沿用模板内置列表: ${formatCatalogError(error)}`,
        );
        return created;
      }
    },
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      const previous = facade.getView();
      const saved = await facade.savePersonalProviderOverlay(providerId, config, metadata);
      // 每次端点事实（baseUrl / apiKey / api 类型）变化都重新拉取网关模型列表；
      // 拉取失败保留已保存配置与模型成员；FCode 向 UI 报告目录失败以支持重试。
      const savedProvider = saved.providers.find((item) => item.providerId === providerId);
      const savedKey = resolveAccessApiKey(savedProvider?.effectiveConfig)?.trim();
      if (!savedKey) return saved;
      // FCode 的空目录可能来自首次保存失败，同一 Key 重试也必须重新获取，不能假报成功。
      if (
        !hasModelCatalogEndpointChange(previous, saved, providerId) &&
        !(providerId === "fcode" && config.access?.type === "api-key" && config.access.apiKey)
      )
        return saved;
      try {
        return await refreshProviderModelCatalog(facade, providerId);
      } catch (error) {
        catalogLogger.warn(
          undefined,
          `[savePersonalProviderOverlay] ${providerId} 端点变更后拉取网关模型目录失败: ${formatCatalogError(error)}`,
        );
        // Key 已持久化但目录未成功，FCode 必须穿透现有失败/重试反馈；其他供应商维持兼容。
        if (providerId === "fcode") {
          throw new Error(`MODEL_CATALOG_REFRESH_FAILED_AFTER_SAVE: ${formatCatalogError(error)}`);
        }
        return saved;
      }
    },
    refreshProviderModelIds: async (providerId) => {
      await ensureReady();
      return refreshProviderModelCatalog(facade, providerId, resolveOAuthModels);
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return facade.deletePersonalProvider(providerId);
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return facade.reorderPersonalProviders(providerIds);
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return facade.reorderPersonalModels(providerId, modelIds);
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig);
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return facade.renamePersonalModel(providerId, currentModelId, nextModelId);
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return facade.deletePersonalModel(providerId, modelId);
    },
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return facade.savePersonalModelDraft(input);
    },
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return facade.setPersonalModelEnabled(providerId, modelId, enabled);
    },
    testModelConnectivity: async (input) => {
      await ensureReady();
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      const model = provider?.models.find((item) => item.modelId === input.modelId);
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : !model || !model.enabled || model.issues.length > 0
            ? "model-unavailable"
            : !provider.executable
              ? "provider-unavailable"
              : !model.executable
                ? "model-unavailable"
                : undefined;
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
      });
    },
  };
}

export { createModelSelectionService } from "./modelSelectionFacadeService.js";

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
