import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import type { ProviderOAuthUsageView } from "@fcode/services";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

type RedeemNotice = "done" | "nothing" | "failed";

const DAY_MS = 86_400_000;

/**
 * Codex "full reset" credits: how many are banked, when they expire, and the button that spends
 * one. Spending is irreversible, so it only happens after an explicit confirmation.
 */
export function ProviderOAuthResetCredits({
  accountId,
  view,
  onChanged,
}: {
  accountId: string;
  view: ProviderOAuthUsageView;
  onChanged: () => Promise<void> | void;
}) {
  const { intl, locale } = useFCodeIntl();
  const { providerOAuthService } = useServices();
  const requestConfirmation = useConfirmDialog();
  const [redeeming, setRedeeming] = useState(false);
  const [notice, setNotice] = useState<RedeemNotice | null>(null);
  const message = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.providerOAuth.usage.${key}` }, values);
  const credits = view.resetCredits;
  const formatMoment = (timestamp: number) => ({
    date: new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp),
    days: Math.max(0, Math.ceil((timestamp - Date.now()) / DAY_MS)),
  });

  if (credits === undefined && view.renewsAt === undefined) return null;
  const nextCredit = credits?.[0];

  const redeem = async () => {
    if (redeeming || !providerOAuthService || !nextCredit) return;
    const expiry = nextCredit.expiresAt
      ? message("resetCredits.expires", formatMoment(nextCredit.expiresAt))
      : message("resetCredits.noExpiry");
    // One explicit confirmation before the irreversible call: the credit is a limited, paid resource.
    const confirmed = await requestConfirmation({
      title: message("resetCredits.confirmTitle"),
      description: message("resetCredits.confirmDescription", {
        count: credits?.length ?? 0,
        expiry,
      }),
      confirmLabel: message("resetCredits.confirm"),
      cancelLabel: message("resetCredits.cancel"),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setRedeeming(true);
    setNotice(null);
    try {
      const result = await providerOAuthService.redeemUsageReset(accountId, nextCredit.id);
      setNotice(result.outcome === "reset" ? "done" : "nothing");
    } catch {
      setNotice("failed");
    } finally {
      setRedeeming(false);
      // Whatever happened, the numbers on screen are stale now.
      await onChanged();
    }
  };

  return (
    <div className="space-y-1.5" data-testid="provider-oauth-reset-credits">
      {view.renewsAt !== undefined ? (
        <p className="text-ui-sm text-foreground-subtle">
          {message("renews", formatMoment(view.renewsAt))}
        </p>
      ) : null}
      {credits !== undefined ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-sm font-medium text-foreground">
              {message("resetCredits.title", { count: credits.length })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={redeeming || credits.length === 0}
              onClick={() => void redeem()}
              data-testid="provider-oauth-reset-credits-redeem"
            >
              {redeeming ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-3.5" />
              )}
              {message("resetCredits.redeem")}
            </Button>
          </div>
          {credits.map((credit, index) => (
            <p
              key={credit.id}
              className="flex justify-between gap-2 text-ui-sm text-foreground-subtle"
            >
              <span>{message("resetCredits.item", { index: index + 1 })}</span>
              <span>
                {credit.expiresAt
                  ? message("resetCredits.expires", formatMoment(credit.expiresAt))
                  : message("resetCredits.noExpiry")}
              </span>
            </p>
          ))}
        </>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={
            notice === "failed"
              ? "text-ui-sm text-destructive"
              : "text-ui-sm text-foreground-subtle"
          }
          data-testid="provider-oauth-reset-credits-notice"
        >
          {message(`resetCredits.${notice}`)}
        </p>
      ) : null}
    </div>
  );
}
