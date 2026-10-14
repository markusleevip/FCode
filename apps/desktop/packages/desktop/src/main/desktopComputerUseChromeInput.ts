import type { ControlRequest } from "@fcode/cua/control-authority";
import { CuaControlError } from "@fcode/cua/control-contract";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeSend } from "./desktopComputerUseChromeState.js";

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  SPACE: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  BACKSPACE: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  DELETE: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ESC: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  LEFT: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  UP: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  RIGHT: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  DOWN: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  HOME: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  END: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PAGEUP: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PAGEDOWN: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};
const MODIFIERS: Record<string, number> = { ALT: 1, OPTION: 1, CTRL: 2, CONTROL: 2, CMD: 4, META: 4, SHIFT: 8 };

/** Scoped browser input. No system clipboard, OS pointer, browser chrome shortcuts or JavaScript editing. */
export async function dispatchChromeInput(request: ControlRequest, send: ChromeSend, signal: AbortSignal) {
  const { method, params } = request.action;
  const point = request.point;
  const mouse = async (type: string, x: number, y: number, options: Record<string, unknown> = {}) => {
    signal.throwIfAborted();
    await send("Input.dispatchMouseEvent", { type, x, y, ...options }, signal);
  };
  if (method === "type_text") {
    if (params.elementIndex !== undefined) throw new CuaControlError("unsupported_action", "Click the observed field before typing.");
    await send("Input.insertText", { text: params.text }, signal);
  } else if (method === "press_keys") {
    const keys = (params.keys as string[]).map((key) => key.toUpperCase());
    const modifiers = keys.reduce((bits, key) => bits | (MODIFIERS[key] ?? 0), 0);
    const ordinary = keys.filter((key) => MODIFIERS[key] === undefined);
    if (ordinary.length !== 1) throw new CuaControlError("unsupported_action");
    const key = ordinary[0];
    // Clipboard and address/tab/window shortcuts would affect shared human state or browser UI.
    if (modifiers && !((modifiers === 4 || modifiers === 2) && key === "A")) throw new CuaControlError("unsupported_action");
    const definition = KEYS[key] ?? (/^[A-Z0-9]$/.test(key) ?
      { key: modifiers ? key.toLowerCase() : key.toLowerCase(), code: /^[A-Z]$/.test(key) ? `Key${key}` : `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0) } : undefined);
    if (!definition) throw new CuaControlError("unsupported_action");
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...definition, modifiers,
      ...(!modifiers && definition.key.length === 1 ? { text: definition.key } : {}) }, signal);
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...definition, modifiers }, signal);
  } else if (point && ["click", "move", "scroll", "drag"].includes(method)) {
    if (method === "move") await mouse("mouseMoved", point.x, point.y);
    else if (method === "scroll") await mouse("mouseWheel", point.x, point.y, { deltaX: params.deltaX ?? 0, deltaY: params.deltaY });
    else {
      const button = method === "drag" ? "left" : params.button ?? "left";
      for (let clickCount = 1; clickCount <= Number(params.count ?? 1); clickCount++) {
        await mouse("mousePressed", point.x, point.y, { button, clickCount, buttons: button === "left" ? 1 : button === "right" ? 2 : 4 });
        if (method === "drag") {
          const end = request.endPoint;
          if (!end) throw new CuaControlError("invalid_request");
          const steps = Math.min(40, Math.max(5, Math.ceil(Number(params.durationMs ?? 500) / 50)));
          for (let i = 1; i <= steps; i++) {
            await delay(Number(params.durationMs ?? 500) / steps, undefined, { signal });
            await mouse("mouseMoved", point.x + (end.x - point.x) * i / steps, point.y + (end.y - point.y) * i / steps,
              { button, buttons: 1 });
          }
          await mouse("mouseReleased", end.x, end.y, { button, buttons: 0, clickCount: 1 });
        } else await mouse("mouseReleased", point.x, point.y, { button, buttons: 0, clickCount });
      }
    }
  } else throw new CuaControlError("unsupported_action");
  return { status: "dispatched", effectVerified: false, inputRouting: "background", inputBackend: "normal-chrome-page" };
}
