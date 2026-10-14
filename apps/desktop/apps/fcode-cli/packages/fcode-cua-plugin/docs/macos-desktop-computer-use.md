# macOS desktop Computer Use

Use this guide only when the trusted catalog reports `runtime.platform: "darwin"` and `runtime.desktop.available: true`. The desktop route requires macOS 14+, a matching protocol 4 Helper, a vision-capable model, system permissions, the currently selected human turn and a live lease. This is a development route; complete application, physical-key and release compatibility remain acceptance gates. Do not claim every app works.

Initialize the official SDK in every `mcp__node_repl__js` cell as specified in SKILL.md. Set the outer tool `timeout_ms` to 120000 for human confirmations. Use `nodeRepl.write` for structured state; screenshots are emitted automatically. Never print image base64, full typed content or private tokens.

The first `computer.desktop.getState()` asks the human to confirm primary-display capture and real mouse/keyboard operation, separately from old selected-window access. Before each observation Main automatically hides its own ordinary FCode windows again if needed; returning to FCode does not cancel the task or require Continue. A visible private modal remains protected and requires human completion. The preview updates when the model observes. Find applications and files using the actual Finder, Dock, Spotlight or file dialogs. Use screenshots and ordinary shortcuts, not shell launchers, guessed bundle IDs or application-specific RPCs. UI discovery works across applications without approving every ordinary click.

| Method | Parameters |
| --- | --- |
| `computer.desktop.getState` | optional `{displayId}`; only the approved primary display |
| `computer.desktop.click` | `{frameId,x,y,button?,count?}` |
| `computer.desktop.move` | `{frameId,x,y}` |
| `computer.desktop.scroll` | `{frameId,x,y,deltaY,deltaX?}` |
| `computer.desktop.drag` | `{frameId,x,y,toX,toY,durationMs?}`; 100–2000 ms |
| `computer.desktop.typeText` | `{frameId,text}`; Unicode, up to 16 KiB, no clipboard |
| `computer.desktop.pressKeys` | `{frameId,keys}`; one non-modifier key plus optional `CMD/CTRL/OPTION/ALT/SHIFT` |

Keys include letters, digits, Enter/Esc/Tab/Space/Backspace/Delete, arrows, Home/End/PageUp/PageDown and F1–F20. Use uppercase names as separate strings, for example `["CMD","SPACE"]` to open Spotlight, `["CMD","SHIFT","G"]` in Finder's Go to Folder UI, or `["ENTER"]`. `WIN`, raw keycodes, modifiers-only chords, arbitrary event flags and routing overrides are unsupported.

Observe → one action → observe → verify. Use `state.frameId`, or `state.desktopObservation.id`; coordinates are integer pixels of that exact PNG. The Helper maps image pixels to Mac screen points, including Retina/scale. Do not use screenshot coordinates from another frame, CSS pixels, guessed desktop coordinates or the human preview. Every input consumes its frame; different action IDs cannot reuse it. Frames expire after 15 seconds.

```js
// Repeat the official bootstrap in every cell.
const state = await computer.desktop.getState();
nodeRepl.write(await computer.desktop.act({method: "pressKeys", params: {frameId: state.frameId, keys: ["CMD", "SPACE"]}}));
```

Choose coordinates only after seeing the PNG. Do not batch guessed clicks. For a user-requested Jianying task, locate the installed application in the real UI, open/import the file through its dialogs, select audio export and the requested directory, and verify export completion. Use a new output name unless overwriting is authorized. If the current app/version/account lacks the operation, report the observed limitation; do not replace the task with ffmpeg or a website.

`status: "dispatched", effectVerified: false` means only that input was sent. Observe the visible effect and verify the requested artifact before reporting completion. If the same intended action twice produces no verified change, reconsider its actual target; if the same obstruction remains after a fresh observation, stop and explain. A long export permits bounded read-only progress checks without clicking Export again. Observe immediately before deciding to wait; use at most a 5-second wait per cell. On the completion screen, check the authorized output file read-only and report completion directly. Do not add fixed 45-second sleeps, repeated Todo updates, or another export.

Physical Esc key-down pauses the task. Your injected Esc does not signal human takeover; ordinary user mouse/keyboard activity may interleave and change the observed target. Ordinary movement, clicks, typing and application/page switching do not mean cancellation: obtain a fresh screenshot, locate the task application through visible UI and continue the original goal. Do not infer takeover merely from foreground visibility. Main checks actual focus, topology, modifiers/buttons, lock state and permissions. The human can return to FCode to Pause/Stop; Stop is independent of model latency. Do not operate FCode, Helper/private confirmation windows or security settings to extend your permission.

On observation_stale, target_changed or a pre-dispatch control_busy without requiresUserAction, obtain a fresh state and reconsider the next step; keep the current task running. Main already performs bounded read-only observation recovery and foreground handoff. Held physical buttons/modifiers mean input contention, not cancellation; briefly wait, observe again and continue after release. Do not repeat the old frame or ask the human to click Continue for ordinary focus changes. Avoid long polling loops or cache searches. A control_busy with requiresUserAction represents a protected dialog: stop and explain the needed human action. On permission_required, secure_input_active, canceled or unavailable transport, stop and explain the fixed reason; the human must use explicit Continue or a new skill selection. Secure Input must be cleared by the human; never disable security or type passwords. On execution_uncertain, stop without replaying the input or switching APIs to repeat it. Old turns, scopes and observations cannot be resumed.

The desktop scope covers only the approved primary display. Do not move to another screen or assume multi-display authorization. Display topology changes revoke usable observations. Mac background application/owned-browser methods remain a separate compatibility route; do not switch to them automatically after desktop consent or failure.

`computer.desktop.act({method,params})` accepts click, move, scroll, drag, typeText or pressKeys with the same existing parameters. It returns `{receipt,state}` after one dispatch and a fresh observation, emits the post-action screenshot, and never retries input. If ordinary target/input contention rejects input before dispatch, it instead obtains a fresh screenshot and returns `receipt.status: "not_dispatched"` with its fixed code. That action was not executed: reconsider the fresh target, end the current edit sequence and continue the task with a newly chosen action. Never chain the next edit/submission on this receipt. Explicit cancellation, protected blockers and uncertain input still throw. Repeat fresh observation before each step of an already verified stable text edit. Reconsider visually after any window, dialog or focus change. Only the latest three operation screenshots are retained in model context; uploaded images remain independent.

Each emitted screenshot includes an automatic short dimension/coordinate-space record. Use its actual pixel width and height, identify the visible control rectangle and click its center. Do not assume a 1000/1024/1600 pixel canvas or use old attachment/preview dimensions. If a click visibly misses, re-estimate its bounds from the new screenshot; clicking a dialog title or repeating the same missed coordinates does not verify focus.

For a text field whose visible focus was already verified, select-all and typing can share one cell. Do not add an unverified click or submission to this sequence. Every step still gets a new Native-checked frame, and a changed foreground ends the sequence:

```js
const field = await computer.desktop.getState();
const editingContext = JSON.stringify(field.desktopObservation.foreground);
const selected = await computer.desktop.act({method: "pressKeys", params: {frameId: field.frameId, keys: ["CMD", "A"]}});
if (selected.receipt.status !== "dispatched") throw new Error("Selection was not dispatched; reconsider the fresh state and continue the task.");
if (JSON.stringify(selected.state.desktopObservation.foreground) !== editingContext) throw new Error("Editing context changed; observe before proceeding.");
const typed = await computer.desktop.act({method: "typeText", params: {frameId: selected.state.frameId, text: userRequestedValue}});
nodeRepl.write({receipt: typed.receipt.status});
```

End this editing sequence on an observation/input failure, unknown focus, dialog or window change. Reconsider a fresh screenshot and continue the task while it remains authorized; ordinary interference is not cancellation. No step is automatically replayed. Visually verify the final field before proceeding.
