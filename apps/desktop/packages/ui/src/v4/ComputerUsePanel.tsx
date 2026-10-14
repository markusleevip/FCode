import { useEffect, useRef, useState } from "react";
import { computerUsePanelStateSchema, type ComputerUsePanelRequest, type ComputerUsePanelState } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { ComputerUsePreview } from "./ComputerUsePreview.js";

export function ComputerUsePanel({ sessionId, focused, canResume, onStopTask, onResume }: {
  sessionId: string;
  focused: boolean;
  canResume: boolean;
  onStopTask(): void;
  onResume(): Promise<unknown>;
}) {
  const platform = useOptionalPlatform();
  const { intl } = useFCodeIntl();
  const [state, setState] = useState<ComputerUsePanelState>({ sessionId: null, status: "none" });
  const [expanded, setExpanded] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const message = (key: string) => intl.formatMessage({ id: `computerUse.panel.${key}` });

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!platform?.getComputerUsePanel || !platform.onComputerUsePanelChanged) return;
    let live = true;
    let changed = false;
    const receive = (value: ComputerUsePanelState) => {
      const parsed = computerUsePanelStateSchema.safeParse(value);
      if (live && parsed.success) setState(parsed.data);
    };
    const unsubscribe = platform.onComputerUsePanelChanged((value) => { changed = true; receive(value); });
    void platform.getComputerUsePanel().then((value) => { if (!changed) receive(value); }).catch(() => {});
    return () => { live = false; unsubscribe(); };
  }, [platform]);
  useEffect(() => {
    if (!platform?.computerUsePanelAction || state.sessionId !== sessionId || state.status !== "active" ||
        !state.managed || !focused || !visible || (!expanded && !enlarged)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await platform.computerUsePanelAction!({ sessionId, action: "preview" }); }
      catch { /* Main projects failures; a closed owner must not restart sampling. */ }
      if (live) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [platform, sessionId, state.sessionId, state.status, state.managed, focused, visible, expanded, enlarged]);
  useEffect(() => { setEnlarged(false); setFailed(false); }, [sessionId]);

  if (state.sessionId !== sessionId || state.status === "none") return null;
  const active = state.status === "active";
  const phase = state.stage === "waiting_model" ? "waitingModel" : state.stage === "preparing" ? "preparing" : state.stage === "waiting_permission" ? "waitingPermission" : undefined;
  const retained = state.status === "paused" || state.status === "handover" || state.stage === "needs_resume";
  const act = async (action: ComputerUsePanelRequest["action"]) => {
    if (!platform?.computerUsePanelAction || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailed(false);
    try {
      await platform.computerUsePanelAction({ sessionId, action });
    } catch { setFailed(true); }
    finally {
      if (action === "pause" || action === "handover" || action === "stop") onStopTask();
      busyRef.current = false;
      setBusy(false);
    }
  };
  const resume = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailed(false);
    try { await onResume(); }
    catch { setFailed(true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const time = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "";
  const controls = (state.status !== "ended" || retained) && <div className="mt-2 flex flex-wrap gap-2">
    {state.managed && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act("show"); }}>{message("show")}</Button>}
    <Button size="sm" variant="outline" disabled={busy || !active} onClick={() => { void act("pause"); }}>{message("pause")}</Button>
    {state.managed && <Button size="sm" variant="outline" disabled={busy || state.status === "handover"} onClick={() => { void act("handover"); }}>{message("takeover")}</Button>}
    <Button size="sm" disabled={busy || !retained || !canResume} onClick={() => { void resume(); }}>{message("resume")}</Button>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act("stop"); }}>{message("stop")}</Button>
  </div>;
  return (
    <section className="rounded-lg border bg-background p-3 text-ui-sm" aria-label={message("title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{message("title")} · {message(phase ?? (state.stage === "needs_resume" ? "needsResume" : active && state.inputRouting === "foreground" ? "desktopActive" : state.status))}</p>
          <p className="truncate text-muted-foreground">{state.applicationName ? message("application") : state.managed ? message("managed") : message("application")} {state.applicationName ?? state.target ?? ""}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{message(expanded ? "collapse" : "expand")}</Button>
      </div>
      {expanded && <div className="mt-2 space-y-2">
        <p>{active && state.action ? intl.formatMessage({ id: state.executing ? "computerUse.panel.action" : "computerUse.panel.lastRequest" }, { action: message(`method.${state.action}`) }) : message(active ? "waiting" : "frozen")}</p>
        {state.image ? <button type="button" className="block w-full overflow-hidden rounded border bg-black/20" onClick={() => setEnlarged(true)} aria-label={message("enlarge")}>
          <ComputerUsePreview state={state} />
        </button> : <p className="flex h-24 items-center justify-center rounded border text-muted-foreground">{message("noImage")}</p>}
        <p className="text-muted-foreground">{message(active ? state.inputRouting === "foreground" ? "desktopSampling" : "sampling" : "snapshot")} {time} {state.previewFailed ? message("stale") : ""}</p>
      </div>}
      {state.failureReason && <p role="alert" className="mt-2 text-destructive">{message(`reason.${state.failureReason}`)}</p>}
      {failed && <p role="alert" className="mt-2 text-destructive">{message("failed")}</p>}
      {controls}
      <Dialog open={enlarged} onOpenChange={setEnlarged}>
        <DialogContent className="max-w-[90vw]">
          <DialogTitle>{message("title")} · {message(state.status)}</DialogTitle>
          {state.image && <ComputerUsePreview state={state} enlarged />}
          <p>{message(active ? state.inputRouting === "foreground" ? "desktopSampling" : "sampling" : "snapshot")} {time} {state.previewFailed ? message("stale") : ""}</p>
          {failed && <p role="alert" className="text-destructive">{message("failed")}</p>}
          {controls}
        </DialogContent>
      </Dialog>
    </section>
  );
}
