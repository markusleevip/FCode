# Windows Computer Use

## Interactive desktop capability

After initializing the official SDK, inspect `computer.listApps()`. When
`runtime.platform` is `win32` and `runtime.desktop.available` is true, use
`computer.desktop` for generic Windows tasks. This is a development capability;
its availability is not a guarantee that every application or task will succeed.
The background method list describes the older application route only.

Start with `nodeRepl.write(await computer.desktop.getState())` in a bootstrapped
cell with outer `timeout_ms: 120000`. Main requests desktop task consent before
capturing or input. It controls the primary display and minimizes FCode. Normal
app discovery and switching are covered by this task scope; do not request an
application grant for every program. The physical mouse, keyboard and foreground
are shared with the human. Only a physical Esc key press signals human takeover;
ordinary mouse motion, clicks, scrolling and other keys do not pause automation.
Your own injected Esc does not signal takeover. Trusted panel Pause/Takeover/Stop,
cancel and independent permission, lock, topology, lease or lifecycle failures
still stop execution. If human interaction changes the actual foreground/focus
or interface, refresh the observation before input instead of inferring takeover.
Never control
FCode, Helper, consent interfaces, password fields or secure/elevated desktops.

The returned PNG is emitted to the model image channel. `frameId` identifies this
observation; `desktopObservation` describes its PNG width/height, display and
foreground. Use integer PNG pixels, not physical screen or UIA coordinates.
Observe, choose one action from the actual image, execute, then observe its effect.
Every input consumes the frame. Do not batch multiple input calls from one frame.
If a frame expires, observe again and reconsider before taking an action.

| Desktop method | Parameters |
| --- | --- |
| `getState` | No parameters; optional already-authorized `displayId` |
| `click` | `frameId, x, y`; optional `button: left/right/middle`, `count: 1..3` |
| `move` | `frameId, x, y` |
| `scroll` | `frameId, x, y, deltaY`; optional `deltaX`; positive Y scrolls down |
| `drag` | `frameId, x, y, toX, toY`; optional `durationMs: 100..2000` |
| `typeText` | `frameId, text`; inserts text into the currently focused field |
| `pressKeys` | `frameId, keys`; a single chord, such as `['WIN']`, `['CTRL','A']`, `['ENTER']` |

Keys are individual uppercase names: letters, digits, F1..F24, WIN, CTRL, ALT,
SHIFT, ENTER, ESC, TAB, SPACE, BACKSPACE, DELETE, INSERT, HOME, END, PAGEUP,
PAGEDOWN, UP, DOWN, LEFT, RIGHT. Type ordinary text using `typeText`, including
Unicode. Observe the focused control before typing; click or use a shortcut to
focus it first and obtain a fresh frame. No clipboard or shell launch fallback.

Discover applications through the visible Start menu, search or All apps.
`listApps` contains running applications and does not describe all installed
software. Do not assume a player is installed or invent an executable path.
Open the user's file through Explorer/default association or the visible Open
with workflow, then inspect the actual application that appears. The same visual
actions work across different players, editors and drawing apps; no per-app
control adapter is required. Use current screenshots rather than remembered
positions, filenames or menu layouts.

A `dispatched` result with `effectVerified:false` means input was inserted, not
that the task succeeded. Verify playback using fresh images and advancing time,
or a drawing/save using its visible result. On a pre-dispatch `control_busy`, wait
for the held physical mouse button or modifier to be released, then observe again
before selecting a new action. This is not human takeover. Never replay the
original action or reuse its frame, and do not bypass another controller's lease.
`computer.desktop.act` obtains one fresh screenshot after a rejected pre-dispatch
`observation_stale`, `target_changed` or ordinary `control_busy`. Its
`receipt.status: "not_dispatched"` means no input was sent. Reconsider the new
state and continue the original task; end any remaining edit sequence and choose
a new action instead of replaying old coordinates. Protected blockers and
explicit cancellation still throw and cannot be resumed by the SDK.
On `execution_uncertain`, stop and
report the uncertain result; never replay the input or switch to a shell route.
The remaining sections document the older limited background route. Do not apply
their Button/Edit or no-foreground restrictions to the explicitly authorized
interactive desktop mode, and do not mix its input with legacy application input.

The current Windows implementation has explicitly built, limited GUI Main
development routes. Packaged support remains unavailable. This document describes
verified routes; it does not enable them or claim complete Windows support.
Report an unavailable host instead of starting a Helper or switching input backends.

Use this guide only when the real `computer.listApps()` result declares
`runtime.platform: "win32"`. The runtime also declares `inputRouting: "background"`,
`compatibility: "limited"` and method names. These describe routes, not authorization
or compatibility with every application. Existing Mac responses without runtime
metadata use the Mac skill and `docs/computer-use.md`.

## Start and observe

Only the main agent may use the official `mcp__node_repl__js` tool. Set its outer
`timeout_ms` to `120000`. Repeat `setupComputerUseRuntime` from the skill in every
cell. Never forge selection/context, import a native transport, change settings,
launch processes, access a clipboard or use shell/PowerShell/Playwright as a fallback.
The human must select this plugin for the current turn. Application access requires
task consent for the exact running process instance; a catalog entry is not a grant.

```js
nodeRepl.write(await computer.listApps());
// In a new cell, repeat bootstrap and use the actual returned appId and pid.
nodeRepl.write(await computer.listWindows({ appId, pid }));
// Select the actual returned windowId, then observe in another initialized cell.
const target = { appId, pid, windowId };
nodeRepl.write(await computer.getAppState(target));
```

Windows `appId` is an opaque registered identity. Never construct it from a path,
Mac bundle ID or filename. Pass only the required target fields; do not pass a whole
catalog entry or invent a PID/window ID. HWND and private UIA runtime IDs are absent
from the public SDK. Do not inspect personal browser windows or operate FCode/Helper.

Current routes address running traditional Win32 controls. Application launch,
task-owned Chrome, private credential input, focus/activation and generic drag are
not currently admitted. Do not call these methods based on Mac examples. Their
future implementation remains part of the full Windows feature.

## Input and effect checks

`getAppState` and `capture` emit the actual PNG through the model image channel.
Use integer pixels from that emitted image for coordinate input, including window
decoration. UIA data is assistance; do not substitute UIA physical screen coordinates
or guessed DPI offsets for PNG pixels. Use `observation.id` as the matching frameId
or stateId. Every input consumes prior observations for that window. Obtain fresh
state in the same cell immediately before one action, then observe the result.

| Method | Current limited route | Required check |
| --- | --- | --- |
| `click` | Left single click on a verified push Button, with `win32-button-notification` assistance | Actual PNG hit; new state verifies the button's business effect |
| `elementAction: press` | An observed enabled Button advertising `press`, scoped Button notification | Current element index; fresh observation verifies effect |
| `elementAction: set_value` | An observed non-password writable Edit advertising `set_value`, whole-value replacement | Verify the intended complete value in new authorized state |
| `typeText` | Character input into an explicit supported Edit index or the verified cached receiver | Verify insertion/selection effect, not merely dispatch |
| `pressKeys` | `['ENTER']` or `['CTRL','A']` on the previously verified Edit receiver | Enter down/up or edit-selection assistance; new observation verifies effect |

No arbitrary combination, double-click, text-field coordinate focus, drag or
application-specific shortcut is implied. A missing advertised method/control action
is a limitation. `unsupported_action` is not permission to activate the target or
dispatch globally. Windows UIA does not use the Mac static-label AX ancestor rules.

```js
// Repeat bootstrap. Select the editable control from the actual current state.
const state = await computer.getAppState(target);
const fields = state.observation.elements.filter(e =>
  e.role === 'Edit' && !e.isPassword && e.enabled && e.actions.includes('set_value'));
if (fields.length !== 1) throw new Error('The intended editable control must be identified uniquely');
const field = fields[0];
nodeRepl.write(await computer.elementAction({
  stateId: state.observation.id, elementIndex: field.index,
  action: 'set_value', value: intendedCompleteValue
}));
const after = await computer.getAppState(target);
const updatedFields = after.observation.elements.filter(e =>
  e.role === 'Edit' && !e.isPassword && e.enabled && e.actions.includes('set_value'));
nodeRepl.write({ valueVerified: updatedFields.length === 1 && updatedFields[0].value === intendedCompleteValue });
```

Choose the field by its actual label/value/location and task meaning when multiple
Edit controls exist. The example requires exactly one supported Edit and still
requires its task meaning to match the intended field. Indices may change after a refresh;
re-identify the field rather than assuming a previous index is permanent.

`set_value` replaces the complete value; it is not keyboard typing. `typeText` inserts
characters and can use an explicit current `elementIndex`. It does not automatically
clear the field. CTRL+A uses `win32-edit-selection` assistance rather than global
modifier state. Pass keys as an array of individual names; `keys: 'CTRL+A'` is invalid.
For a supported address Edit, first verify a replacement, then obtain new state and
send Enter; confirm directory/page contents changed before reporting navigation.

## Stop, errors and privacy

Receipts use `status: 'dispatched'`, `effectVerified: false` and
`inputBackend: 'win32-window-messages'`. They report dispatch, not task success.
An action can be delivered without the intended business effect. Verify with a new
PNG and current state. Empty/truncated UIA data is not a complete observation;
inspect `elementsTruncated` and its reason and report limitations honestly.

Inspect `error.code` when present. For `execution_uncertain`, do not replay, change
the action ID, renew control or switch methods. Stop and report the unknown result.
For stale/changed observations, obtain new state and reconsider; an old approval,
frame or receiver must not be revived. Cancellation does not undo completed effects.
Pause/Takeover/Stop are trusted user controls, not SDK methods. Continue requires a
new explicitly selected human turn. Native Show/Takeover is not yet admitted in
this prototype; do not claim it transferred control. No screenshot, input, lease or
authorization persists across a stopped task for model reuse.

Passwords/protected controls cannot be set or typed. No Windows private credential
route is currently available; never send passwords through a prompt, ordinary
typing, elementAction, output or clipboard. Do not print screenshot base64, hidden
values, permission tokens or private references. Keep completion claims tied to the
actual Windows application's observed effects, not a browser substitute or fixture.

## Short observation loop

For the desktop route, initialize as above, observe a fresh frame and call `computer.desktop.act({method,params})` with a documented input method and that frame. It performs one input, emits the post-action screenshot and returns `{receipt,state}` without input replay or automatic effect verification. The shared Host/Core retain only the latest three Computer Use screenshots in model context, independently of user-uploaded images. For long-running work observe before waiting, use at most a 5-second wait in a cell, and finish promptly after visible completion and the authorized read-only artifact check. Never poll for 100 seconds, sleep 45 seconds first or switch backends on failure.
