import type { AiSdkModelAdapter } from "@fcode/adapters/model";
import type { Model } from "@fcode/contracts";
import type { AgentRuntimeDeps } from "@fcode/core";
import {
  getNativeProviderPresentation,
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@fcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(provider, registryModel, target);
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      // 修复依据：内部 new-provider 是路由身份，不是厂商品牌；与 UI 复用同一公开投影。
      displayName: `${getNativeProviderPresentation(provider.config.access)?.providerName ?? (provider.providerName?.trim() || provider.providerId)}/${registryModel.modelId}`,
      providerConfig: provider.config,
      modelConfig: config,
      // 原生执行入口已提供逐 attempt 的 source；遗漏传递会丢掉已准入的账号鉴权材料。
      ...(provider.config.access.type === "provider-oauth" ||
      (provider.config.access.type === "zhipu-account" &&
        provider.config.access.mode === "off-peak")
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
