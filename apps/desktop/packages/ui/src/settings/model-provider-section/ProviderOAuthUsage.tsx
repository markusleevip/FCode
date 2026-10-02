import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderOAuthResetCredits } from "./ProviderOAuthResetCredits.js";
import { ProviderOAuthUsageRows } from "./ProviderOAuthUsageRows.js";
import { useProviderOAuthUsage } from "./useProviderOAuthUsage.js";

const AUTO_REFRESH_MS = 5 * 60_000;

/** 设置页账号卡片内的额度区块；仅展示 Host 查询结果，失败只影响本区块。 */
export function ProviderOAuthUsage({ accountId }: { accountId: string }) {
  const { intl } = useFCodeIntl();
  const message = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.providerOAuth.usage.${key}` }, values);
  const { view, failed, loading, reload } = useProviderOAuthUsage(accountId, AUTO_REFRESH_MS);
  return (
    <div className="space-y-2" data-testid="provider-oauth-usage">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">
          {message("title")}
          {view?.plan ? (
            <span className="ml-2 font-normal text-foreground-subtle">
              {message("plan", { plan: view.plan })}
            </span>
          ) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          aria-label={message("refresh")}
          onClick={() => void reload()}
          data-testid="provider-oauth-usage-refresh"
        >
          <RefreshCwIcon className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>
      {failed ? (
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
        <ProviderOAuthUsageRows windows={view.windows} />
      )}
      {view && !failed ? (
        <ProviderOAuthResetCredits accountId={accountId} view={view} onChanged={reload} />
      ) : null}
    </div>
  );
}
