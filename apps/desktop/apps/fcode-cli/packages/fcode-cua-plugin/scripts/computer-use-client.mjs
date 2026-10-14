const BRIDGE = Symbol.for("fcode.node-repl.computer-use-bridge");
const DESKTOP_INPUT_METHODS = new Set(["click", "move", "scroll", "drag", "typeText", "pressKeys"]);
const DESKTOP_METHODS = { click: "desktop_click", move: "desktop_move", scroll: "desktop_scroll",
  drag: "desktop_drag", typeText: "desktop_type_text", pressKeys: "desktop_press_keys" };
const DESKTOP_REOBSERVE_CODES = new Set(["observation_stale", "target_changed", "control_busy"]);

/** The SDK has no native, process, network or permission implementation. All actions use the private call bridge. */
export async function setupComputerUseRuntime({ globals = globalThis } = {}) {
  const bridge = globals[BRIDGE];
  if (!bridge || typeof bridge.call !== "function") throw new Error("Computer Use requires the official FCode Node REPL host.");
  bridge.assertAvailable();
  let captureIndex = 0;
  const invoke = async (method, params = {}) => {
    const result = await bridge.call(method, params);
    if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? "Computer Use failed.");
    for (const item of result.content ?? []) {
      if (item.type === "image") {
        if (!globals.nodeRepl?.emitImage) throw new Error("Computer Use screenshots require the model image channel.");
        globals.nodeRepl.emitImage({ base64: item.data, mimeType: item.mimeType });
      }
    }
    if (!result.structuredContent || typeof result.structuredContent !== "object") throw new Error("Computer Use returned no structured state.");
    const state = result.structuredContent;
    const observation = state.desktopObservation ?? state.observation;
    if (result.content?.some((item) => item.type === "image") &&
        Number.isSafeInteger(observation?.width) && Number.isSafeInteger(observation?.height)) {
      globals.nodeRepl?.write?.({ computerScreenshot: { index: ++captureIndex,
        width: observation.width, height: observation.height, coordinateSpace: state.coordinateSpace ?? "window-image-pixels" },
        targeting: "Use these exact image pixels and the visible control center. If input misses, observe and re-estimate its bounds; do not repeat the old coordinates or assume a focus failure." });
    }
    return result.structuredContent;
  };
  const computer = Object.freeze({
    desktop: Object.freeze({
      getState: (params = {}) => invoke("desktop_get_state", params),
      click: (params) => invoke("desktop_click", params),
      move: (params) => invoke("desktop_move", params),
      scroll: (params) => invoke("desktop_scroll", params),
      drag: (params) => invoke("desktop_drag", params),
      typeText: (params) => invoke("desktop_type_text", params),
      pressKeys: (params) => invoke("desktop_press_keys", params),
      // Observe immediately after dispatch, without claiming its business effect or replaying input.
      act: async ({ method, params } = {}) => {
        if (!DESKTOP_INPUT_METHODS.has(method)) throw new TypeError("desktop.act requires a documented input method.");
        let receipt;
        try { receipt = await invoke(DESKTOP_METHODS[method], params); }
        catch (error) {
          if (error?.requiresUserAction || !DESKTOP_REOBSERVE_CODES.has(error?.code)) throw error;
          // These codes prove rejection before dispatch. Never replay the original input.
          receipt = { status: "not_dispatched", effectVerified: false, code: error.code };
          globals.nodeRepl?.write?.({ desktopRecovery: receipt,
            guidance: "Ordinary foreground or input contention is not cancellation. Reconsider the fresh screenshot and continue the task; do not chain the remaining edit steps or replay old coordinates." });
        }
        const state = await invoke("desktop_get_state");
        return { receipt, state };
      },
    }),
    listApps: () => invoke("list_apps"),
    openApplication: async (params) => {
      const result = await invoke("open_application", params);
      const { appId, pid } = result.target;
      return { ...result, target: { appId, pid } };
    },
    openBrowser: async (params) => {
      const result = await invoke("open_browser", params);
      const { appId, pid, windowId } = result.target;
      return { ...result, target: { appId, pid, windowId } };
    },
    listWindows: (target) => invoke("list_windows", target),
    getAppState: (target) => invoke("get_app_state", target),
    capture: (target) => invoke("capture", target),
    activateWindow: (target) => invoke("activate_window", target),
    prepareInput: (params) => invoke("prepare_input", params),
    click: (params) => invoke("click", params),
    move: (params) => invoke("move", params),
    drag: (params) => invoke("drag", params),
    scroll: (params) => invoke("scroll", params),
    typeText: (params) => invoke("type_text", params),
    requestCredential: (params) => invoke("request_credential", params),
    typeCredential: (params) => invoke("type_credential", params),
    pressKeys: (params) => invoke("press_keys", params),
    elementAction: (params) => invoke("element_action", params),
  });
  Object.defineProperty(globals, "computer", { value: computer, configurable: true });
  return computer;
}
