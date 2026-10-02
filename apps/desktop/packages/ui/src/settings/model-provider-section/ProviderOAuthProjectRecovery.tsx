import { useId, useState } from "react";
import type { ProviderOAuthFlowView } from "@fcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function ProviderOAuthProjectRecovery({
  flow,
  disabled,
  fallbackAccountId,
  onAuthorize,
}: {
  flow: ProviderOAuthFlowView;
  disabled: boolean;
  fallbackAccountId?: string | null;
  onAuthorize: (accountId: string | undefined, projectId: string) => void;
}) {
  const { intl } = useFCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.providerOAuth.${key}` });
  const [projectId, setProjectId] = useState("");
  const inputId = useId();
  if (
    flow.status !== "failed" ||
    flow.supplier !== "antigravity" ||
    !["project_required", "project_not_returned", "invalid_project", "invalid_project_id"].includes(
      flow.error ?? "",
    )
  )
    return null;
  return (
    <form
      className="space-y-2"
      data-testid="provider-oauth-project-recovery"
      onSubmit={(event) => {
        event.preventDefault();
        // 重试使用 Host 投影的目标账号，避免在账号详情外丢失重授权身份。
        onAuthorize(flow.targetAccountId ?? fallbackAccountId ?? undefined, projectId);
      }}
    >
      <p role="alert" className="text-ui-sm text-destructive">
        {message(flow.error === "project_required" ? "projectRequired" : "projectNotReturned")}
      </p>
      <label htmlFor={inputId} className="block text-ui-sm">
        {message("projectId")}
      </label>
      <Input
        id={inputId}
        value={projectId}
        onChange={(event) => setProjectId(event.target.value)}
        data-testid="provider-oauth-project-id"
        required
        minLength={6}
        maxLength={30}
        pattern="[a-z][a-z0-9\-]{4,28}[a-z0-9]"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        placeholder="my-project-123"
      />
      <p className="text-ui-sm text-foreground-subtle">{message("projectInstructions")}</p>
      <Button
        type="submit"
        variant="outline"
        data-testid="provider-oauth-project-retry"
        disabled={disabled || !projectId.trim()}
      >
        {message("retryWithProject")}
      </Button>
    </form>
  );
}
