// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 IFCodeAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 fcode-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@fcode/rpc";
import type {
  FCodePluginOperationProgressNotification,
  FCodePluginsConfigureResult,
  FCodePluginsCancelOperationResult,
  FCodePluginsDescribeResult,
  FCodePluginsInstallResult,
  FCodePluginsListResult,
  FCodePluginsMarketplaceMutationResult,
  FCodePluginsOverviewResult,
  FCodePluginsReferenceCatalogResult,
  FCodePluginsRestoreBuiltinResult,
  FCodePluginsSetEnabledResult,
  FCodePluginsUninstallResult,
  FCodePluginsValidateResult,
} from "@fcode/shared";
import { ServiceChannels } from "@fcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  FCodeAgentAddPluginMarketplaceParams,
  FCodeAgentConfigurePluginParams,
  FCodeAgentCancelPluginOperationParams,
  FCodeAgentDescribePluginParams,
  FCodeAgentInstallPluginParams,
  FCodeAgentPluginReferenceCatalogParams,
  FCodeAgentResolveSuggestedPluginReferenceParams,
  FCodeAgentResetPluginConfigParams,
  FCodeAgentPluginViewParams,
  FCodeAgentRemovePluginMarketplaceParams,
  FCodeAgentRestoreBuiltinPluginParams,
  FCodeAgentSetPluginEnabledParams,
  FCodeAgentUninstallPluginParams,
  FCodeAgentUpdatePluginMarketplaceParams,
  FCodeAgentUpdatePluginParams,
  FCodeAgentValidatePluginParams,
} from "../fcode-agent/fcodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: FCodeAgentPluginViewParams): Promise<FCodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: FCodeAgentPluginReferenceCatalogParams,
  ): Promise<FCodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: FCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@fcode/shared").FCodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<FCodePluginOperationProgressNotification>;
  getPluginsOverview(params: FCodeAgentPluginViewParams): Promise<FCodePluginsOverviewResult>;
  addPluginMarketplace(
    params: FCodeAgentAddPluginMarketplaceParams,
  ): Promise<FCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: FCodeAgentRemovePluginMarketplaceParams,
  ): Promise<FCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: FCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<FCodePluginsMarketplaceMutationResult>;
  installPlugin(params: FCodeAgentInstallPluginParams): Promise<FCodePluginsInstallResult>;
  cancelPluginOperation(
    params: FCodeAgentCancelPluginOperationParams,
  ): Promise<FCodePluginsCancelOperationResult>;
  uninstallPlugin(params: FCodeAgentUninstallPluginParams): Promise<FCodePluginsUninstallResult>;
  updatePlugin(params: FCodeAgentUpdatePluginParams): Promise<FCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: FCodeAgentRestoreBuiltinPluginParams,
  ): Promise<FCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: FCodeAgentConfigurePluginParams): Promise<FCodePluginsConfigureResult>;
  resetPluginConfig(
    params: FCodeAgentResetPluginConfigParams,
  ): Promise<FCodePluginsConfigureResult>;
  validatePlugin(params: FCodeAgentValidatePluginParams): Promise<FCodePluginsValidateResult>;
  describePlugin(params: FCodeAgentDescribePluginParams): Promise<FCodePluginsDescribeResult>;
  setPluginEnabled(params: FCodeAgentSetPluginEnabledParams): Promise<FCodePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
