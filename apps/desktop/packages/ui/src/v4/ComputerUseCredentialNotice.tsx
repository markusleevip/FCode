import { useEffect, useState } from "react";
import type { ComputerUseCredentialUiState } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function ComputerUseCredentialNotice({ sessionId }: { sessionId: string }) {
  const platform = useOptionalPlatform();
  const { intl } = useFCodeIntl();
  const [state, setState] = useState<ComputerUseCredentialUiState>({ sessionId: null, status: "none" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!platform?.getComputerUseCredentialUi || !platform.onComputerUseCredentialUiChanged) return;
    let live = true;
    let changed = false;
    const unsubscribe = platform.onComputerUseCredentialUiChanged((value) => {
      changed = true;
      if (live) { setState(value); setFailed(false); }
    });
    // A cached Main snapshot does not start a Helper or poll ordinary tasks.
    void platform.getComputerUseCredentialUi().then((value) => {
      if (live && !changed) setState(value);
    }).catch(() => {});
    return () => { live = false; unsubscribe(); };
  }, [platform]);

  if (state.sessionId !== sessionId || state.status === "none") return null;
  const focus = async () => {
    if (!platform?.focusComputerUseCredentialUi || busy) return;
    setBusy(true);
    setFailed(false);
    try { await platform.focusComputerUseCredentialUi(sessionId); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-ui-sm" role="status">
      <div className="min-w-0 break-words">
        <p>{intl.formatMessage({ id: state.status === "ready" ? "computerUse.credential.ready" : "computerUse.credential.pending" }, { origin: state.origin ?? "" })}</p>
        {failed && <p className="text-destructive">{intl.formatMessage({ id: "computerUse.credential.unavailable" })}</p>}
      </div>
      {state.status === "pending" && (
        <Button type="button" size="sm" disabled={busy} onClick={() => { void focus(); }}>
          {intl.formatMessage({ id: "computerUse.credential.enter" })}
        </Button>
      )}
    </div>
  );
}
