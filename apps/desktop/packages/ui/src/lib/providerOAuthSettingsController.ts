import type {
  IProviderOAuthService,
  IProviderSettingsService,
  ProviderOAuthAccountView,
  ProviderOAuthFlowView,
  ProviderOAuthSupplier,
} from "@fcode/services";

export interface ProviderOAuthSettingsState {
  readonly suppliers: Awaited<ReturnType<IProviderOAuthService["getSuppliers"]>> | readonly [];
  readonly accounts: readonly ProviderOAuthAccountView[];
  readonly flow?: ProviderOAuthFlowView;
  readonly busy: boolean;
  readonly error?: "unavailable" | "failed" | "catalogFailed" | "importFailed";
  readonly catalogAccountId?: string;
}
export const EMPTY_PROVIDER_OAUTH_SETTINGS: ProviderOAuthSettingsState = {
  suppliers: [],
  accounts: [],
  busy: false,
};
const pending = (flow?: ProviderOAuthFlowView) =>
  flow?.status === "awaiting" || flow?.status === "exchanging";

/** UI 命令编排与 Host 投影；不持有 token，也不推断 Host 授权结果。 */
export class ProviderOAuthSettingsController {
  private state: ProviderOAuthSettingsState = EMPTY_PROVIDER_OAUTH_SETTINGS;
  private readonly listeners = new Set<(state: ProviderOAuthSettingsState) => void>();
  private readonly completedFlows = new Set<string>();
  private generation = 0;
  private readGeneration = 0;
  private disposed = false;
  constructor(
    private readonly service: IProviderOAuthService | undefined,
    private readonly providers: IProviderSettingsService,
    private readonly onConnected?: (providerId: string) => void,
  ) {}

  getSnapshot(): ProviderOAuthSettingsState {
    return this.state;
  }
  subscribe(listener: (state: ProviderOAuthSettingsState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.service) {
      this.reportError("unavailable");
      return;
    }
    const read = ++this.readGeneration;
    try {
      const [suppliers, accounts] = await Promise.all([
        this.service.getSuppliers(),
        this.service.getAccounts(),
      ]);
      // 恢复连接只清除读取错误；周期读取不能隐藏模型目录等操作失败。
      if (!this.disposed && read === this.readGeneration)
        this.update({
          suppliers,
          accounts,
          ...(this.state.error === "unavailable" ? { error: undefined } : {}),
        });
    } catch {
      if (!this.disposed && read === this.readGeneration) this.reportError("unavailable");
    }
  }
  async poll(): Promise<void> {
    if (this.disposed || this.state.busy || !this.service) return;
    const flow = this.state.flow;
    if (!pending(flow)) return;
    const generation = this.generation;
    try {
      const next = await this.service.getLogin(flow!.state);
      if (!this.current(generation)) return;
      if (next.status === "connected") await this.run((current) => this.acceptFlow(next, current));
      else this.update({ flow: next });
    } catch {
      if (this.current(generation)) this.reportError("failed");
    }
  }
  startLogin(
    supplier: ProviderOAuthSupplier,
    accountId?: string,
    projectId?: string,
  ): Promise<void> {
    return this.run(async (generation) => {
      if (pending(this.state.flow)) await this.service!.cancelLogin(this.state.flow!.state);
      const flow = await this.service!.startLogin({
        supplier,
        ...(accountId ? { accountId } : {}),
        ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
      });
      // 页面已关闭或 Host 已切换；必须撤销迟到的远端 flow，不能更新新页面。
      if (!this.current(generation)) {
        await this.service!.cancelLogin(flow.state);
        return;
      }
      await this.acceptFlow(flow, generation);
    });
  }
  submitCallback(url: string): Promise<void> {
    const state = this.state.flow?.state;
    if (!state) return Promise.resolve();
    return this.run(async (generation) =>
      this.acceptFlow(await this.service!.submitCallback(state, url), generation),
    );
  }
  async cancelLogin(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const flow = this.state.flow;
    this.update({ busy: false, error: undefined });
    if (!pending(flow) || !this.service) return;
    try {
      const cancelled = await this.service.cancelLogin(flow!.state);
      if (this.current(generation)) await this.acceptFlow(cancelled, generation);
    } catch {
      if (this.current(generation)) this.reportError("failed");
    }
  }
  connectAccount(accountId: string): Promise<void> {
    return this.run((generation) => this.connect(accountId, generation));
  }
  retry(): Promise<void> {
    const accountId = this.state.catalogAccountId;
    return this.state.error === "catalogFailed" && accountId
      ? this.connectAccount(accountId)
      : this.load();
  }
  setEnabled(accountId: string, enabled: boolean): Promise<void> {
    return this.run(async () => {
      await this.service!.setAccountEnabled(accountId, enabled);
      await this.load();
    });
  }
  removeAccount(accountId: string): Promise<void> {
    return this.run(async () => {
      await this.service!.removeAccount(accountId);
      await this.load();
    });
  }
  refreshAccount(accountId: string): Promise<void> {
    return this.run(async () => {
      await this.service!.refreshAccount(accountId);
      await this.load();
    });
  }
  importAccount(json: string, location?: string): Promise<void> {
    return this.run(async (generation) => {
      const account = await this.service!.importAccount({
        json,
        ...(location?.trim() ? { location: location.trim() } : {}),
      });
      if (this.current(generation)) await this.connect(account.accountId, generation);
    }, "importFailed");
  }
  reportError(error: NonNullable<ProviderOAuthSettingsState["error"]>): void {
    if (!this.disposed) this.update({ error });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.readGeneration += 1;
    this.listeners.clear();
    if (pending(this.state.flow))
      await this.service?.cancelLogin(this.state.flow!.state).catch(() => undefined);
  }
  private async acceptFlow(flow: ProviderOAuthFlowView, generation: number): Promise<void> {
    if (!this.current(generation)) return;
    this.update({ flow });
    if (flow.status !== "connected" || !flow.accountId || this.completedFlows.has(flow.state))
      return;
    this.completedFlows.add(flow.state);
    await this.connect(flow.accountId, generation);
  }
  private async connect(accountId: string, generation: number): Promise<void> {
    if (!this.current(generation)) return;
    const providerId = await this.service!.connectAccount(accountId);
    if (!this.current(generation)) return;
    try {
      await this.providers.refreshProviderModelIds(providerId);
    } catch {
      if (this.current(generation)) {
        await this.load();
        if (this.current(generation))
          this.update({ error: "catalogFailed", catalogAccountId: accountId });
      }
      return;
    }
    await this.load();
    if (this.current(generation)) this.onConnected?.(providerId);
  }
  private async run(
    operation: (generation: number) => Promise<void>,
    error: NonNullable<ProviderOAuthSettingsState["error"]> = "failed",
  ): Promise<void> {
    if (this.disposed || this.state.busy) return;
    if (!this.service) {
      this.reportError("unavailable");
      return;
    }
    const generation = ++this.generation;
    this.update({ busy: true, error: undefined, catalogAccountId: undefined });
    try {
      await operation(generation);
    } catch {
      if (this.current(generation)) this.reportError(error);
    } finally {
      if (this.current(generation)) this.update({ busy: false });
    }
  }
  private current(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }
  private update(update: Partial<ProviderOAuthSettingsState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener(this.state);
  }
}
