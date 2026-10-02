import { Loader2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderOAuthUsageRows } from "@/settings/model-provider-section/ProviderOAuthUsageRows.js";
import { useProviderOAuthUsage } from "@/settings/model-provider-section/useProviderOAuthUsage.js";

/** The Codex / Antigravity / Cline account bound to the current model, resolved by the toolbar from Registry access and never self-reported by the agent. */
export interface ChatOAuthUsageConfig {
  accountId: string;
  modelId?: string;
}

/** 悬停面板内容仅在打开时挂载，因此挂载即查询一次（Host 侧另有 30 秒缓存）。 */
export function ChatOAuthUsagePanel({
  config,
  separated = false,
}: {
  config: ChatOAuthUsageConfig;
  separated?: boolean;
}) {
  const { intl } = useFCodeIntl();
  const message = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.providerOAuth.usage.${key}` }, values);
  const { view, failed, loading } = useProviderOAuthUsage(config.accountId);
  return (
    <div className={cn(separated && "border-t border-border pt-2")} data-testid="chat-oauth-usage">
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {message("title")}
        </span>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        ) : null}
        {view?.plan ? (
          <span className="ml-auto shrink-0 text-ui-sm text-foreground-subtle">
            {message("plan", { plan: view.plan })}
          </span>
        ) : null}
      </div>
      {failed && !view ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {message("failed")}
        </p>
      ) : !view ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {message("loading")}
        </p>
      ) : view.windows.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{message("empty")}</p>
      ) : (
        <ProviderOAuthUsageRows
          windows={view.windows}
          {...(config.modelId ? { currentModelId: config.modelId } : {})}
        />
      )}
      {view?.resetCredits !== undefined ? (
        <p
          className="mt-2 text-ui-sm text-foreground-subtle"
          data-testid="chat-oauth-reset-credits"
        >
          {message("resetCredits.title", { count: view.resetCredits.length })}
        </p>
      ) : null}
    </div>
  );
}
