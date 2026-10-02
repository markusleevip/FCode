// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListFCodeSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunFCodeProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  FCodeApp,
  FCodeAppOptions,
  FCodeModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectFCodeCustomCommand,
  listFCodeCustomCommands,
  loadFCodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectFCodeCustomCommandOptions,
  ListFCodeCustomCommandsOptions,
  FCodeCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addFCodePluginMarketplace,
  getFCodePluginsOverview,
  installFCodeMarketplacePlugin,
  listFCodePlugins,
  removeFCodePluginMarketplace,
  resolveFCodePlugins,
  setFCodePluginEnabled,
  uninstallFCodeMarketplacePlugin,
  updateFCodeMarketplacePlugin,
  updateFCodePluginMarketplace,
  validateFCodePluginPath,
} from "./plugins.js";
export type {
  AddFCodeMarketplaceOptions,
  InstallFCodeMarketplacePluginOptions,
  ListFCodePluginsOptions,
  RemoveFCodeMarketplaceOptions,
  ResolveFCodePluginsOptions,
  SetFCodePluginEnabledOptions,
  SetFCodePluginEnabledResult,
  UninstallFCodeMarketplacePluginOptions,
  UpdateFCodeMarketplaceOptions,
  UpdateFCodeMarketplacePluginOptions,
  ValidateFCodePluginPathOptions,
  FCodeAvailablePluginData,
  FCodeInstalledPluginData,
  FCodeMarketplaceSummaryData,
  FCodeMarketplaceUpdateData,
  FCodePluginInstallData,
  FCodePluginUpdateData,
  FCodePluginsOverviewData,
} from "./plugins.js";
export { runFCodeProtocolAgent } from "./fcode-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./fcode-protocol/session-mapper.js";
export { prepareFCodeTelemetryEnv, shutdownFCodeTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listFCodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectFCodeSkill, listFCodeSkills } from "./skills.js";
export type {
  InspectFCodeSkillOptions,
  ListFCodeSkillsOptions,
  FCodeSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedFCodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
