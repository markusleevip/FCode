import { useEffect, useRef, useState } from "react";
import type { ComputerUsePanelState } from "@fcode/shared";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { computerUsePointerLayout } from "./computerUsePointerLayout.js";

const CLICK_FEEDBACK_MS = 600;
const FADE_AFTER_MS = 2400;

/** Human-only display decoration: never modifies the raster sent to a model. */
export function ComputerUsePreview({ state, enlarged = false }: { state: ComputerUsePanelState; enlarged?: boolean }) {
  const { intl } = useFCodeIntl();
  const image = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number }>();
  const [now, setNow] = useState(Date.now);
  const pointer = state.operationPointer;
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNow(Date.now());
    if (!pointer) return;
    const timers = [pointer.updatedAt + CLICK_FEEDBACK_MS, pointer.updatedAt + FADE_AFTER_MS, pointer.expiresAt]
      .filter((deadline) => deadline > Date.now()).map((deadline) => setTimeout(() => setNow(Date.now()), deadline - Date.now()));
    return () => timers.forEach(clearTimeout);
  }, [pointer?.sequence, pointer?.updatedAt, pointer?.expiresAt]);
  const geometry = state.previewGeometry;
  const position = loaded && loaded.src === state.image && loaded.width === geometry?.width && loaded.height === geometry.height ?
    computerUsePointerLayout(state, box, now) : undefined;
  const label = intl.formatMessage({ id: pointer?.kind === "control-target" ? "computerUse.panel.controlTarget" : "computerUse.panel.aiPointer" });
  return <span className="relative block w-full overflow-hidden" data-testid="computer-use-preview">
    <img ref={image} src={state.image} alt={intl.formatMessage({ id: "computerUse.panel.image" })}
      className={enlarged ? "max-h-[75vh] w-full object-contain" : "max-h-56 w-full object-contain"}
      onLoad={(event) => {
        const element = event.currentTarget, rect = element.getBoundingClientRect();
        setLoaded({ src: element.currentSrc, width: element.naturalWidth, height: element.naturalHeight });
        setBox({ width: rect.width, height: rect.height });
      }} onError={() => setLoaded(undefined)} />
    {position && pointer && <span role="img" aria-label={label} title={label} data-testid="computer-use-operation-pointer"
      className="pointer-events-none absolute z-10 motion-safe:transition-opacity"
      style={{ left: position.left, top: position.top, opacity: now >= pointer.updatedAt + FADE_AFTER_MS ? 0.4 : 1 }}>
      {pointer.phase === "click" && now < pointer.updatedAt + CLICK_FEEDBACK_MS &&
        <span data-testid="computer-use-click-ring" className="absolute -left-3 -top-3 size-6 rounded-full border-2 border-violet-500 bg-violet-500/20" />}
      <svg width="24" height="28" viewBox="0 0 24 28" aria-hidden="true" className="absolute drop-shadow-md" style={{ left: -1, top: -1 }}>
        <path d="M1 1L1 22L7 17L12 26L17 23L12 14L22 13Z" fill="#7c3aed" stroke="white" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <span className="absolute left-4 top-4 rounded bg-violet-700 px-1 text-[9px] font-semibold leading-3 text-white shadow-sm">
        {pointer.kind === "control-target" ? "◎ AI" : "AI"}
      </span>
    </span>}
  </span>;
}
