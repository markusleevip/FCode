import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PROVIDER_OAUTH_LOGIN_SUPPLIERS,
  PROVIDER_OAUTH_SUPPLIERS,
  type ProviderOAuthFlowView,
  type ProviderOAuthSupplier,
} from "./contract.js";
import type { ProviderOAuthAccountRepository } from "./accountRepository.js";
import type { NativeProviderOAuthProtocol } from "./protocol.js";
import { validateAntigravityProjectId } from "./antigravityProject.js";
import {
  ProviderOAuthError,
  type ProviderDeviceAuthorization,
  type ProviderOAuthAttempt,
  type ProviderOAuthTokens,
} from "./types.js";

interface LoginFlow {
  attempt: ProviderOAuthAttempt;
  view: ProviderOAuthFlowView;
  abort: AbortController;
  target?: { accountId: string; revision: number };
  server?: Server;
  closed?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  work?: Promise<ProviderOAuthFlowView>;
  committing: boolean;
}

interface FlowOptions {
  ports?: Partial<Record<ProviderOAuthSupplier, number>>;
  now?: () => number;
  browserTimeoutMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const CALLBACKS = {
  codex: { port: 1455, path: "/auth/callback" },
  claude: { port: 54545, path: "/callback" },
  antigravity: { port: 51121, path: "/oauth-callback" },
  devin: { port: 0, path: "/callback" },
} as const;

/** 单个 Host 的授权会话所有者；只输出状态投影，不输出临时凭据。 */
export class ProviderOAuthFlowController {
  private readonly flows = new Map<string, LoginFlow>();
  private readonly now: () => number;
  private readonly wait: NonNullable<FlowOptions["wait"]>;
  private disposed = false;

  constructor(
    private readonly accounts: ProviderOAuthAccountRepository,
    private readonly protocol: NativeProviderOAuthProtocol,
    private readonly options: FlowOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
  }

  async startLogin(input: {
    supplier: ProviderOAuthSupplier;
    accountId?: string;
    projectId?: string;
  }): Promise<ProviderOAuthFlowView> {
    if (this.disposed) throw new ProviderOAuthError("host_disposed");
    const supplier = PROVIDER_OAUTH_LOGIN_SUPPLIERS.find((item) => item.id === input.supplier);
    if (!supplier) throw new ProviderOAuthError("unsupported_supplier");
    if (input.projectId !== undefined && supplier.id !== "antigravity")
      throw new ProviderOAuthError("invalid_project_id");
    const projectId =
      input.projectId === undefined ? undefined : validateAntigravityProjectId(input.projectId);
    for (const [state, flow] of this.flows) {
      if (!this.active(flow) && !flow.committing && flow.view.expiresAt + 300_000 < this.now())
        this.flows.delete(state);
    }
    if (
      this.flows.size >= 64 ||
      [...this.flows.values()].filter((flow) => this.active(flow)).length >= 16
    )
      throw new ProviderOAuthError("too_many_authorizations");
    const target = input.accountId ? await this.accounts.getAccount(input.accountId) : undefined;
    if (this.disposed) throw new ProviderOAuthError("host_disposed");
    if (target && target.supplier !== supplier.id)
      throw new ProviderOAuthError("account_identity_mismatch");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const flow: LoginFlow = {
      attempt: {
        supplier: supplier.id,
        state,
        verifier,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        deviceId: randomUUID(),
        redirectUri: "",
        ...(projectId ? { projectId } : {}),
      },
      abort: new AbortController(),
      target,
      committing: false,
      view: {
        state,
        supplier: supplier.id,
        status: "awaiting",
        expiresAt: this.now() + (this.options.browserTimeoutMs ?? 600_000),
        ...(target ? { targetAccountId: target.accountId } : {}),
      },
    };
    this.flows.set(state, flow);
    this.deadline(flow);
    try {
      if (supplier.flow === "browser") {
        await this.listen(flow);
        if (this.active(flow))
          flow.view = { ...flow.view, authorizeUrl: this.protocol.authorizeUrl(flow.attempt) };
      } else {
        const device = await this.protocol.startDevice(flow.attempt, flow.abort.signal);
        if (this.active(flow)) {
          flow.view = {
            ...flow.view,
            authorizeUrl: device.authorizeUrl,
            userCode: device.userCode,
            expiresAt: this.now() + device.expiresIn * 1000,
          };
          this.deadline(flow);
          flow.work = this.poll(flow, device);
        }
      }
    } catch (error) {
      this.fail(flow, error);
    }
    return this.getLogin(state);
  }

  getLogin(state: string): ProviderOAuthFlowView {
    const flow = this.find(state);
    if (this.active(flow) && !flow.committing && flow.view.expiresAt <= this.now())
      this.terminal(flow, "expired");
    return { ...flow.view };
  }

  async submitCallback(state: string, callbackUrl: string): Promise<ProviderOAuthFlowView> {
    const flow = this.find(state);
    if (!this.active(flow)) return this.getLogin(state);
    if (!flow.attempt.redirectUri) throw new ProviderOAuthError("unsupported_flow");
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new ProviderOAuthError("invalid_callback");
    }
    const expected = new URL(flow.attempt.redirectUri);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port !== expected.port ||
      url.pathname !== expected.pathname ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== state
    )
      throw new ProviderOAuthError("invalid_callback");
    if (flow.work) return flow.work;
    if (url.searchParams.has("error")) {
      // Claude 的账号/组织受限原先被吞成普通拒绝；只识别精确白名单，不能透传私密正文或 error_uri。
      const accountOnHold =
        flow.attempt.supplier === "claude" &&
        url.searchParams.getAll("error").length === 1 &&
        url.searchParams.get("error") === "access_denied" &&
        url.searchParams.getAll("error_description").length === 1 &&
        url.searchParams.get("error_description") === "account_on_hold";
      this.fail(flow, new ProviderOAuthError(accountOnHold ? "account_on_hold" : "access_denied"));
      return this.getLogin(state);
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.getAll("code").length !== 1 || code.length > 16_384)
      throw new ProviderOAuthError("invalid_callback");
    flow.view = { ...flow.view, status: "exchanging" };
    flow.work = this.exchange(flow, code);
    return flow.work;
  }

  async cancelLogin(state: string): Promise<ProviderOAuthFlowView> {
    const flow = this.find(state);
    if (flow.committing) return flow.work ?? this.getLogin(state);
    if (this.active(flow)) this.terminal(flow, "cancelled");
    return this.getLogin(state);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const flow of this.flows.values())
      if (this.active(flow) && !flow.committing) this.terminal(flow, "cancelled");
    await Promise.all(
      [...this.flows.values()].map(async (flow) => {
        if (flow.committing) await flow.work;
        await flow.closed;
      }),
    );
  }

  private async listen(flow: LoginFlow): Promise<void> {
    const supplier = flow.attempt.supplier;
    if (!(supplier in CALLBACKS)) throw new ProviderOAuthError("unsupported_flow");
    const config = CALLBACKS[supplier as keyof typeof CALLBACKS];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("connection", "close");
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method !== "GET" || !request.url || request.url.length > 20_000) {
        response.writeHead(400).end("Invalid callback");
        return;
      }
      try {
        const result = await this.submitCallback(
          flow.attempt.state,
          new URL(request.url, flow.attempt.redirectUri).toString(),
        );
        response
          .writeHead(result.status === "connected" ? 200 : 400)
          .end(
            result.status === "connected"
              ? "Authorization complete. You can return to FCode. 授权完成，请返回 FCode。"
              : result.error === "account_on_hold"
                ? "Claude denied authorization: account or organization on hold (account_on_hold). Check your account at claude.ai/restricted. Claude 返回账号或组织受限，未授予访问权限。请到 claude.ai/restricted 确认状态，再返回 FCode。"
                : "Authorization did not complete. Please return to FCode. 请返回 FCode 查看授权结果。",
          );
      } catch {
        response.writeHead(400).end("Invalid callback");
      }
    });
    flow.server = server;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new ProviderOAuthError("callback_port_unavailable")));
      server.listen(this.options.ports?.[supplier] ?? config.port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new ProviderOAuthError("callback_port_unavailable");
    flow.attempt.redirectUri = `http://localhost:${address.port}${config.path}`;
    if (!this.active(flow)) this.cleanup(flow);
  }

  private async exchange(flow: LoginFlow, code: string): Promise<ProviderOAuthFlowView> {
    try {
      await this.commit(
        flow,
        await this.protocol.exchangeCode(flow.attempt, code, flow.abort.signal),
      );
    } catch (error) {
      this.fail(flow, error);
    }
    return this.getLogin(flow.attempt.state);
  }

  private async poll(
    flow: LoginFlow,
    device: ProviderDeviceAuthorization,
  ): Promise<ProviderOAuthFlowView> {
    let interval = device.interval * 1000;
    while (this.active(flow)) {
      try {
        await this.wait(interval, flow.abort.signal);
        if (this.getLogin(flow.attempt.state).status !== "awaiting") break;
        const tokens = await this.protocol.pollDevice(flow.attempt, device, flow.abort.signal);
        await this.commit(flow, tokens);
      } catch (error) {
        if (error instanceof ProviderOAuthError && error.code === "authorization_pending") continue;
        if (error instanceof ProviderOAuthError && error.code === "slow_down") {
          interval += 5000;
          continue;
        }
        this.fail(flow, error);
      }
    }
    return this.getLogin(flow.attempt.state);
  }

  private async commit(flow: LoginFlow, tokens: ProviderOAuthTokens): Promise<void> {
    if (!this.active(flow)) throw new ProviderOAuthError("cancelled");
    flow.view = { ...flow.view, status: "exchanging" };
    const account = await this.accounts.saveAuthorization({
      supplier: flow.attempt.supplier,
      tokens,
      displayName:
        tokens.email ??
        PROVIDER_OAUTH_SUPPLIERS.find((item) => item.id === flow.attempt.supplier)!.name,
      target: flow.target,
      onBeforeCommit: () => {
        if (!this.active(flow) || this.now() >= flow.view.expiresAt || this.disposed)
          throw new ProviderOAuthError("cancelled");
        flow.committing = true;
        clearTimeout(flow.timer);
      },
    });
    flow.view = { ...flow.view, status: "connected", accountId: account.accountId };
    flow.committing = false;
    this.cleanup(flow);
  }

  private fail(flow: LoginFlow, error: unknown): void {
    flow.committing = false;
    if (!this.active(flow)) return;
    const code = error instanceof ProviderOAuthError ? error.code : "authorization_failed";
    if (code === "expired_token") this.terminal(flow, "expired");
    else this.terminal(flow, "failed", code);
  }

  private terminal(
    flow: LoginFlow,
    status: "failed" | "cancelled" | "expired",
    error?: string,
  ): void {
    flow.view = { ...flow.view, status, error };
    flow.abort.abort();
    this.cleanup(flow);
  }

  private deadline(flow: LoginFlow): void {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(
      () => {
        if (this.active(flow) && !flow.committing) this.terminal(flow, "expired");
      },
      Math.max(0, flow.view.expiresAt - this.now()),
    );
    flow.timer.unref();
  }

  private cleanup(flow: LoginFlow): void {
    clearTimeout(flow.timer);
    if (flow.server && !flow.closed) {
      flow.closed = new Promise((resolve) => flow.server!.close(() => resolve()));
      flow.server.closeIdleConnections();
    }
  }

  private active(flow: LoginFlow): boolean {
    return flow.view.status === "awaiting" || flow.view.status === "exchanging";
  }
  private find(state: string): LoginFlow {
    const flow = this.flows.get(state);
    if (!flow) throw new ProviderOAuthError("authorization_not_found");
    return flow;
  }
}
