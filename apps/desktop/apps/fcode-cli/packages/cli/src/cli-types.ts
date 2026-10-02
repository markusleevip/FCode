import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@fcode/tui";
import type { UiLocale } from "@fcode/i18n";
import type { Logger } from "@fcode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@fcode/adapters/browser";
import type {
  createModelAdapter,
  createFCodeApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectFCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectFCodeCustomCommand,
  InspectFCodeCustomCommandOptions,
  InspectFCodeSkillOptions,
  loginFCodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginFCodeCliOptions,
  listFCodeCustomCommands,
  ListFCodeCustomCommandsOptions,
  loadFCodeCustomCommand,
  listFCodeSessions,
  listFCodeSkills,
  ListFCodeSessionsOptions,
  ListFCodeSkillsOptions,
  logoutFCodeCli,
  LogoutFCodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunFCodeProtocolAgentOptions,
  prepareFCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownFCodeTelemetry,
  FCodeAppOptions,
} from "@fcode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@fcode/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunFCodeProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createFCodeApp?: (
    options?: FCodeAppOptions,
  ) => Awaited<ReturnType<typeof createFCodeApp>> | ReturnType<typeof createFCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createFCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectFCodeSkillOptions) => ReturnType<typeof inspectFCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectFCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectFCodeCustomCommand>;
  loginFCodeCli?: (options?: LoginFCodeCliOptions) => ReturnType<typeof loginFCodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareFCodeTelemetryEnv?: typeof prepareFCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListFCodeSessionsOptions) => ReturnType<typeof listFCodeSessions>;
  listCustomCommands?: (
    options: ListFCodeCustomCommandsOptions,
  ) => ReturnType<typeof listFCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectFCodeCustomCommandOptions,
  ) => ReturnType<typeof loadFCodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedFCodeSlashCommandName"];
  listSkills?: (options: ListFCodeSkillsOptions) => ReturnType<typeof listFCodeSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutFCodeCli?: (options?: LogoutFCodeCliOptions) => ReturnType<typeof logoutFCodeCli>;
  runFCodeProtocolAgent?: (options?: RunFCodeProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@fcode/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownFCodeTelemetry?: typeof shutdownFCodeTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createFCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
