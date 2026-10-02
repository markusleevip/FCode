import { useState } from "react";
import { ProviderOAuthProjectRecovery } from "./ProviderOAuthProjectRecovery.js";
import { ProviderOAuthUsage } from "./ProviderOAuthUsage.js";
import { ProviderOAuthFlowStatus } from "./ProviderOAuthFlowStatus.js";
import { getNativeProviderPresentation } from "@fcode/provider";
import { ProviderLogo } from "./ProviderLogo.js";
import { LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useProviderOAuth } from "@/hooks/useProviderOAuth.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function ProviderOAuthConnections({
  accountId,
  onConnected,
}: {
  accountId?: string | null;
  onConnected?: (providerId: string) => void;
}) {
  const oauth = useProviderOAuth(onConnected);
  const platform = usePlatform();
  const confirm = useConfirmDialog();
  const { intl, locale } = useFCodeIntl();
  const message = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.providerOAuth.${key}` }, values);
  const [callback, setCallback] = useState("");
  const [location, setLocation] = useState("global");
  const { state } = oauth;
  const flow = state.flow;
  const pending = flow?.status === "awaiting" || flow?.status === "exchanging";
  const disabled = state.busy || pending;
  const selectedAccount = accountId !== undefined;
  const accounts = selectedAccount
    ? state.accounts.filter((account) => account.accountId === accountId)
    : state.accounts;
  const remove = async (id: string, name: string) => {
    if (
      await confirm({
        title: message("removeTitle"),
        description: message("removeDescription", { name }),
        confirmLabel: message("remove"),
        confirmVariant: "destructive",
      })
    )
      await oauth.removeAccount(id);
  };
  return (
    <section
      className="space-y-3"
      data-testid="provider-oauth-connections"
      aria-label={message("title")}
    >
      <h3 className="text-ui-base font-medium text-foreground-subtle">{message("title")}</h3>
      {!selectedAccount ? (
        <p className="text-ui-sm text-foreground-subtle">{message("description")}</p>
      ) : null}
      {!state.suppliers.length && !state.error ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {state.error ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 p-3 text-ui-sm text-destructive"
          data-testid="provider-oauth-error"
        >
          <p>{message(state.error)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={state.busy}
            onClick={() => void oauth.retry()}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {state.busy ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {message("working")}
        </p>
      ) : null}
      {flow ? (
        <div
          className="space-y-3 rounded-lg border border-border bg-surface p-3"
          data-testid="provider-oauth-flow"
          data-flow-status={flow.status}
        >
          <ProviderOAuthFlowStatus flow={flow} />
          {flow.status === "failed" && flow.error?.includes("callback_port_unavailable") ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {message("portUnavailable")}
            </p>
          ) : null}
          <ProviderOAuthProjectRecovery
            flow={flow}
            disabled={disabled}
            fallbackAccountId={accountId}
            onAuthorize={(target, projectId) => {
              void oauth.startLogin("antigravity", target, projectId);
            }}
          />
          {pending ? (
            <>
              <p className="text-ui-sm text-foreground-subtle">
                {message(flow.userCode ? "deviceInstructions" : "browserInstructions")}
              </p>
              {flow.userCode ? (
                <output
                  tabIndex={0}
                  className="block select-all rounded-md border border-border bg-input p-3 font-mono text-ui-lg"
                  aria-label={message("deviceCode")}
                  data-testid="provider-oauth-device-code"
                >
                  {flow.userCode}
                </output>
              ) : null}
              <p className="text-ui-sm text-foreground-subtle">
                {message("expires", { time: new Date(flow.expiresAt).toLocaleTimeString(locale) })}
              </p>
              <div className="flex flex-wrap gap-2">
                {flow.authorizeUrl ? (
                  <Button asChild variant="outline" data-testid="provider-oauth-open-page">
                    <a
                      href={flow.authorizeUrl}
                      onClick={(event) => {
                        event.preventDefault();
                        platform.openExternal(flow.authorizeUrl!);
                      }}
                    >
                      {message("openPage")}
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void oauth.cancelLogin()}
                  data-testid="provider-oauth-cancel"
                >
                  {message("cancel")}
                </Button>
              </div>
              {!flow.userCode ? (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void Promise.resolve(oauth.submitCallback(callback)).finally(() =>
                      setCallback(""),
                    );
                  }}
                >
                  <label
                    className="block text-ui-sm text-foreground-subtle"
                    htmlFor="provider-oauth-callback"
                  >
                    {message("callbackLabel")}
                  </label>
                  <Input
                    id="provider-oauth-callback"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={callback}
                    onChange={(event) => setCallback(event.target.value)}
                    placeholder="http://localhost:1455/auth/callback?..."
                    data-testid="provider-oauth-callback"
                    disabled={state.busy}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={state.busy || !callback.trim()}
                    data-testid="provider-oauth-submit-callback"
                  >
                    {message("submitCallback")}
                  </Button>
                </form>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {!selectedAccount ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {state.suppliers.map((supplier) => {
            const presentation = getNativeProviderPresentation({
              type: "provider-oauth",
              supplier: supplier.id,
              accountId: "",
            });
            return (
              <button
                key={supplier.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setCallback("");
                  void oauth.startLogin(supplier.id);
                }}
                data-testid={`provider-oauth-login-${supplier.id}`}
                className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left text-ui-base transition-colors hover:border-border-hover hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
              >
                {presentation ? (
                  <ProviderLogo logo={presentation.logo} className="size-5" />
                ) : (
                  <LogInIcon
                    className="size-5 shrink-0 text-foreground-subtle"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span className="block font-medium">
                    {presentation?.providerName ?? supplier.name}
                  </span>
                  <span className="block text-ui-sm text-foreground-subtle">
                    {message(supplier.flow === "device" ? "deviceLogin" : "browserLogin")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {selectedAccount && !accounts.length && state.suppliers.length ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {message("missingAccount")}
        </p>
      ) : null}
      {accounts.map((account) => {
        const presentation = getNativeProviderPresentation({
          type: "provider-oauth",
          supplier: account.supplier,
          accountId: account.accountId,
        });
        return (
          <div
            key={account.accountId}
            className="space-y-3 rounded-lg border border-border bg-surface p-3"
            data-testid={`provider-oauth-account-${account.accountId}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 break-all text-ui-base font-medium">
                  {presentation ? (
                    <ProviderLogo logo={presentation.logo} className="size-5" />
                  ) : null}
                  {presentation?.providerName ?? account.displayName}
                </p>
                {!presentation ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {state.suppliers.find((item) => item.id === account.supplier)?.name ??
                      "Google Vertex AI"}
                  </p>
                ) : null}
              </div>
              <span
                className={
                  account.needsAuthorization
                    ? "text-ui-sm text-destructive"
                    : "text-ui-sm text-foreground-subtle"
                }
                data-testid="provider-oauth-account-status"
              >
                {message(
                  account.needsAuthorization
                    ? "needsAuthorization"
                    : account.enabled
                      ? "enabled"
                      : "disabled",
                )}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled || !account.enabled || account.needsAuthorization}
                onClick={() => void oauth.connectAccount(account.accountId)}
                data-testid="provider-oauth-account-models"
              >
                {message(account.providerId ? "refreshModels" : "connect")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => void oauth.setEnabled(account.accountId, !account.enabled)}
                data-testid="provider-oauth-account-toggle"
              >
                {message(account.enabled ? "disable" : "enable")}
              </Button>
              {account.supplier !== "vertex" ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setCallback("");
                    void oauth.startLogin(
                      account.supplier as Exclude<typeof account.supplier, "vertex">,
                      account.accountId,
                    );
                  }}
                  data-testid="provider-oauth-account-relogin"
                >
                  {message("reauthorize")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || !account.enabled}
                  onClick={() => void oauth.refreshAccount(account.accountId)}
                >
                  {message("refreshAuthorization")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  void remove(account.accountId, presentation?.providerName ?? account.displayName)
                }
                data-testid="provider-oauth-account-remove"
              >
                {message("remove")}
              </Button>
            </div>
            {(account.supplier === "codex" ||
              account.supplier === "antigravity" ||
              account.supplier === "cline") &&
            account.enabled &&
            !account.needsAuthorization ? (
              <ProviderOAuthUsage accountId={account.accountId} />
            ) : null}
            <p
              className="text-ui-sm text-foreground-subtle"
              data-testid="provider-oauth-model-source"
              data-catalog-source={account.modelCatalogSource ?? "unknown"}
            >
              {message(
                account.modelCatalogSource === "account"
                  ? "accountModelHint"
                  : account.modelCatalogSource === "preset"
                    ? "modelPermissionHint"
                    : "unknownModelHint",
              )}
            </p>
          </div>
        );
      })}
      {!selectedAccount ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="block text-ui-base font-medium" htmlFor="provider-oauth-import">
            {message("import")}
          </label>
          <p className="text-ui-sm text-foreground-subtle">{message("importDescription")}</p>
          <input
            id="provider-oauth-import"
            type="file"
            accept=".json,application/json"
            disabled={disabled}
            className="block w-full text-ui-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1 file:text-ui-sm file:text-foreground"
            data-testid="provider-oauth-import"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void oauth.importFile(file, location);
            }}
          />
          <label
            className="block text-ui-sm text-foreground-subtle"
            htmlFor="provider-oauth-location"
          >
            {message("location")}
          </label>
          <Input
            id="provider-oauth-location"
            value={location}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="global / us-central1"
            data-testid="provider-oauth-location"
          />
        </div>
      ) : null}
    </section>
  );
}
