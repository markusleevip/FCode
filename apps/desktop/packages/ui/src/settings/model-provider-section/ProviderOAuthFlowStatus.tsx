import type { ProviderOAuthFlowView } from "@fcode/services";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function ProviderOAuthFlowStatus({ flow }: { flow: ProviderOAuthFlowView }) {
  const { intl } = useFCodeIntl();
  const platform = usePlatform();
  // 只消费 Host 的受控状态；厂商传来的错误 URL 和账号资料不进入界面。
  const restricted =
    flow.supplier === "claude" && flow.status === "failed" && flow.error === "account_on_hold";
  return (
    <>
      <p role={restricted ? "alert" : "status"} className="text-ui-base font-medium">
        {intl.formatMessage({
          id: restricted
            ? "settings.providerOAuth.claudeAccountOnHold"
            : `settings.providerOAuth.status.${flow.status}`,
        })}
      </p>
      {restricted ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void platform.openExternal("https://claude.ai/restricted")}
          data-testid="provider-oauth-claude-account-status"
        >
          {intl.formatMessage({ id: "settings.providerOAuth.checkClaudeAccount" })}
        </Button>
      ) : null}
    </>
  );
}
