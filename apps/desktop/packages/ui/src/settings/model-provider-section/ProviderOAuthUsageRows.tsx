import { Progress } from "@/components/ui/progress.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import {
  groupUsageWindows,
  splitCurrentUsageGroup,
  type ProviderOAuthUsageGroup,
} from "@/lib/providerOAuthUsageGroups.js";
import type { ProviderOAuthUsageWindow } from "@fcode/services";

type Message = (key: string, values?: Record<string, string | number>) => string;

/** 额度行列表。传入 currentModelId 时当前模型所在组置顶，其余组紧随其后，不折叠。 */
export function ProviderOAuthUsageRows({
  windows,
  currentModelId,
}: {
  windows: readonly ProviderOAuthUsageWindow[];
  currentModelId?: string;
}) {
  const { intl } = useFCodeIntl();
  const message: Message = (key, values) =>
    intl.formatMessage({ id: `settings.providerOAuth.usage.${key}` }, values);
  const { current, others } = splitCurrentUsageGroup(groupUsageWindows(windows), currentModelId);
  return (
    <div className="space-y-2">
      {current ? <UsageRow group={current} message={message} /> : null}
      {others.map((group) => (
        <UsageRow key={group.id} group={group} message={message} />
      ))}
    </div>
  );
}

function UsageRow({ group, message }: { group: ProviderOAuthUsageGroup; message: Message }) {
  const used = Math.round(group.usedPercent);
  const reset = group.resetsAt ? formatDuration(group.resetsAt - Date.now(), message) : undefined;
  const label = groupLabel(group, message);
  return (
    <div className="space-y-1" data-testid="provider-oauth-usage-window">
      <div className="flex items-baseline justify-between gap-2 text-ui-sm">
        <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
        <span className="shrink-0 text-foreground-subtle">
          {message("used", { percent: used })}
          {reset ? ` · ${message("resetsIn", { time: reset })}` : ""}
        </span>
      </div>
      {group.family && group.members.length > 0 ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("includes", { names: group.members.join(", ") })}
        </p>
      ) : null}
      <Progress
        value={used}
        aria-label={label}
        className="h-1.5 bg-foreground/10"
        indicatorClassName={used >= 90 ? "bg-destructive" : used >= 70 ? "bg-warning" : undefined}
      />
    </div>
  );
}

function groupLabel(group: ProviderOAuthUsageGroup, message: Message): string {
  if (group.family) return message(`family.${group.family}`);
  const seconds = group.windowSeconds;
  if (!seconds) return message("window.unknown");
  if (seconds === 7 * 86_400) return message("window.weekly");
  if (seconds >= 28 * 86_400 && seconds <= 31 * 86_400) return message("window.monthly");
  if (seconds % 86_400 === 0) return message("window.days", { count: seconds / 86_400 });
  return message("window.hours", { count: Math.round(seconds / 3600) });
}

function formatDuration(ms: number, message: Message): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return message("duration.dayHour", { d, h });
  if (h > 0) return message("duration.hourMinute", { h, m });
  return message("duration.minute", { m });
}
