# @fcode/cua

Computer Use product acceptance is in progress. The local macOS development
build stages a Swift Helper and an official plugin, disabled by default.
The legacy broker, installer and PiP surfaces remain unavailable.

The new `control-contract`, `control-authority` and `control-geometry` modules
define the Host-owned authorization and action boundary. Registration and grant
methods must never be exposed to model code. `native-session/node` is a private
Desktop main-process adapter for the macOS Swift Helper, with bounded JSON
transport, independent stop, cancellation and uncertain-result handling.

`invocation-registry` binds root-window selection proofs to actual human turns
and tool calls. `control-transport/node` is a lazy private Host endpoint;
`runtime-client-node` forwards only bound calls. A Node REPL Worker receives a
short-lived parent broker token, never the root transport credential. The GUI
Main owns native startup, task app consent and the turn lease. Ordinary supported
actions reuse that task's consent and still pass live authorization checks.
The task heartbeat spans model thinking between tools and is revoked when
the turn ends. An uncertain input blocks further input, while authorized
read-only observation remains available for recovery.

Run the control and transport tests from the repository root:

```sh
node --test apps/desktop/packages/cua/test/*.test.mjs
cd apps/desktop
node --import tsx --test packages/cua/test/*.test.ts
```

The native sources and build script live in `packages/desktop`. The explicit
native smoke test runs in an Electron GUI main process, exercises a controlled
test window and verifies real capture/input. It is not product or website
acceptance. The diagnostic Helper mode allows status only.

Website tasks now route through the normally installed Google Chrome in a fresh
headful task instance with a private parent-only debugging pipe. The model SDK
exposes only scoped page methods, never the pipe, arbitrary evaluation or a
personal browser profile. SDK page coordinates use emitted PNG pixels mapped privately to the CSS viewport;
trusted user preview captures the complete normal Chrome window through Native.
Other applications retain verified background AX actions and add experimental window-addressed visual mouse, text and key input on compatible native windows. App-specific rejection is reported without global fallback; inactive Electron keys remain a compatibility limitation. No global mouse,
clipboard or foreground input fallback is used. Credentials are collected in a
private Native secure panel and consumed only by Main after verifying the same
HTTPS document and focused protected field. Unknown dispatched browser input
closes only the task-owned process before transfer. Normal Chrome fixture tests
verify background page input, scroll, drag, window preview and rejected protected
plaintext input; final normal-browser run.sh website acceptance is pending.

Real local `run.sh` tests have verified selected-turn app/window enumeration,
activation, native shortcuts and model-visible screenshots. Website lesson
completion, full shutdown/performance regression, installation/upgrade and
production signing are not yet accepted. Windows remains unavailable. See the
repository-root `specs/computer-use.md` for the internal acceptance contract;
runtime and builds do not depend on that document.

License: Apache-2.0.
