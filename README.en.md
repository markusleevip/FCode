<p align="center">
  <img src="brand/fcode-logo.svg" alt="FCode" width="480">
</p>
<p align="center">A desktop AI coding assistant with direct OAuth sign-in for Codex and more</p>
<p align="center">
  <a href="https://github.com/markusleevip/FCode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/markusleevip/FCode?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/markusleevip/FCode?style=flat-square"></a>
</p>
<p align="center"><a href="README.md">简体中文</a> | English</p>

FCode is a desktop AI assistant that lets you sign in directly with accounts such as Codex through OAuth, with no API key required. After installing it, authorize an account in the model settings, pick a model, and start chatting or working on local projects.

## Highlight: sign in with your account via OAuth

No need to request, copy and safeguard API keys. Click once in FCode, sign in with the account you already have in the browser, and chat directly with the models that account can access:

![FCode demo: authorize Codex and Antigravity, chat, and check subscription usage](docs/images/demo.gif)

- **One-step Codex and Antigravity authorization**: choose the account when adding a provider and authorize in the browser. The model list is fetched automatically and you enable the models you want with a switch.
- **Cline device-code sign-in**: sign in with a Cline account by confirming a device code in the browser, with no API key to copy. The model list is fetched automatically after authorization, and some models carry a **Free** badge (served free of charge by Cline).
- **Many accounts, one place**: besides Codex, Antigravity and Cline you can pick Anthropic / Claude (browser authorization) and Kimi, Kimi.ai and xAI / Grok (device-code authorization). The Add provider page in the app is the source of truth.
- **Subscription usage at a glance**: Codex, Antigravity and Cline accounts show plan usage, percentage used and reset time in model settings and in the chat input; see "View subscription usage" below.
- **Works even when the callback fails**: if the browser cannot call back automatically, paste the full callback URL back into FCode to submit it instead of starting over.
- **Models come from the account itself**: the list is refreshed from what the account actually returns, not a hard-coded preset. When authorization expires, click "Authorize again" in the UI.
- API-key setups remain available through the FCode provider and your own API key.

Which models each account can use depends on the permissions the service returns; rely on the refreshed model list and a real conversation.

## Download

Installers are published on the [Releases page](https://github.com/markusleevip/FCode/releases/latest). The source repository itself contains no binary installers.

| Platform | Package |
| --- | --- |
| macOS (Apple silicon, M series, arm64) | `.dmg` |
| Windows x64 | `.exe` installer |

The macOS package is for Macs with an M-series chip (M1, M2, M3, M4 and so on) only and does not support Intel-based Macs. No installer is provided for Intel Macs yet; you can try building from source (`package.sh x64`, not verified by us).

Each package comes with a same-named `.sha256` checksum file; verifying it after download is recommended.

## Features

- Chat with an AI in a desktop window and work on local code after choosing a project directory.
- OAuth sign-in with accounts such as Codex, Antigravity and Cline, plus the FCode provider and your own API key.
- View subscription usage of Codex, Antigravity and Cline accounts inside the app.
- Plugins, MCP, skills, subagents and workflows.
- A built-in browser for viewing and operating web pages.
- Workspaces, sessions and settings are stored on your machine.

## Quick start: connect Codex or Antigravity

The walkthrough below shows how to sign in to Codex and Antigravity inside FCode through account authorization and then chat directly with the configured models. The screenshots were taken on macOS; window chrome on Windows may differ, and button labels depend on the interface language.

### 1. Install FCode

Get the package for your platform from the Download table above and install it, then launch FCode. The current macOS packaging flow is neither signed nor notarized, so macOS may block it from opening; use only packages from this project's Releases page. If there is no package for your platform, build from source as described in "Build from source" below. Using a package does not require Node.js, pnpm or any build command.

Before connecting an account, prepare a Codex or Antigravity account and make sure you can open the authorization page in a browser. The models actually available depend on what the service returns and on real conversations.

### 2. Open model settings

If you see "Welcome to FCode" on first launch, click **Skip for now** to enter the main window. The main window may show **No model available. Configure a model provider in Settings.** This means no usable model is configured yet. Click **Set** on the right of the notice, or open **Preferences** at the bottom left and go to **Model settings**.

### 3. Add a provider and authorize the account

In model settings, click **Add provider** at the top right, then choose **Codex** or **Antigravity** (both use **Browser authorization**) under **Sign in with a provider account**. The app then shows **Waiting for authorization**.

1. If the browser does not open automatically, click **Open authorization page**.
2. Sign in to the account you want to use in the browser and follow the on-page prompts to authorize.
3. Return to FCode and wait for the authorization result to update.
4. If the browser fails to complete the callback automatically, paste the final **full callback URL** from the browser address bar into **Complete callback URL**, then click **Submit callback**. The `http://localhost:1455/auth/callback?...` shown in the screenshot is only a format hint. Use the real URL produced by your own authorization, including all query parameters.

If authorization expires, start it again. If the callback port is reported as occupied, close other apps that are in the middle of an authorization and retry. The full callback URL can contain temporary authorization data, so paste it only into the callback field of FCode on your own machine. The same page also offers Claude (browser authorization) and Kimi, Kimi.ai, xAI / Grok and Cline (device-code authorization); follow the on-page prompts.

**Cline uses device-code authorization**: choose **Cline**, open the authorization page as prompted, sign in to your Cline account in the browser and confirm the device code shown in the app, then return to FCode and wait for the result to update. No callback URL needs to be submitted.

![Add provider: choose an account, authorize in the browser and, if needed, submit the full callback URL](docs/images/002.png)

### 4. Confirm authorization and enable models

After authorization, the account appears under **Custom providers** on the left. Select it and confirm the status is **Enabled**. If the model list is empty or needs updating, click **Refresh models**, then turn on the switch next to each model you want to use. The **Usage limits** block in the account card also shows your subscription usage; see "6. View subscription usage" below.

| Codex | Antigravity |
| --- | --- |
| ![Codex authorized, model list enabled, with plan usage and reset credits](docs/images/003.png) | ![Antigravity authorized, model list enabled, with usage per model group](docs/images/004.png) |

![Cline authorized, model list enabled, with the plan and 5-hour, weekly and monthly usage limits](docs/images/005.png)

The screenshots show the model lists returned for these particular accounts. Model names and counts vary by account and over time, so rely on the list you get when you refresh. **Receiving a model list does not prove that chat access has been verified.** Send a message to confirm.

### 5. Pick a model and chat

Click **Back to workspace**, start a conversation with **New task**, and choose **Codex/model name**, **Antigravity/model name** or **Cline/model name** in the model menu at the lower right of the input box, then send a message.

Send a simple message first, for example "Hello, please briefly describe what you can help me with." Once you get a normal reply, start real work. To work on local code, choose the project directory with **Select project** and describe what you need, for example: "Read the project structure first and explain how to start this project."

**Full access** in the screenshots is a permission option. Before working on a project, choose the permission scope that fits your needs in that menu.

| Codex | Antigravity |
| --- | --- |
| ![Chatting with a Codex model](docs/images/006.png) | ![Chatting with an Antigravity model](docs/images/007.png) |

### 6. View subscription usage

Once a Codex, Antigravity or Cline account is authorized and enabled, you can check its subscription usage in two places:

- **Model settings**: in the **Usage limits** block of the account card (see the screenshots in step 4 above); click the refresh button on the right to update it. Codex shows the plan, the Weekly limit percentage used, the reset countdown and the renewal time, plus the number of **Reset credits** and when each one expires. Antigravity shows usage per model group (for example Gemini models and Claude / GPT models), each with percentage used and a reset countdown. Cline shows the plan (for example Cline Pass) and the 5-hour, weekly and monthly limits, each with percentage used and a reset countdown.
- **Chat input**: hover over the usage ring to the left of the model selector to open a popup. Its upper part shows the context window usage of the current conversation (Context windows), and its lower part shows the usage limits of the account behind the current model, without leaving the conversation.

![Hovering the usage ring in the chat input: context window usage and the current account's usage limits](docs/images/008.png)

Notes:

- Usage data comes from what each service returns, and the items shown differ by account and plan. The plan, percentages and model names in the screenshots are examples only; rely on what your own account displays. The Cline plan and limit tiers likewise depend on what the app shows for your account.
- **Reset limits** on a Codex account consumes one reset credit, so confirm you really need it before clicking. Accounts without reset credits do not show it.
- If usage is missing or stale, click the refresh button. If it still fails, check your network and, if needed, click **Authorize again**.

### Troubleshooting

| Symptom | What to do |
| --- | --- |
| Still shows no model available | Check that the Codex account is enabled and the model switch is on, then pick the model again in the chat view. |
| Stuck waiting for authorization | Finish signing in in the browser. If the callback does not happen automatically, submit the full callback URL from this authorization. If it expired, authorize again. |
| Account connected, but fetching the model list fails | Select Codex and click Refresh models again. If only the model list failed, you do not need to sign in again. |
| Models are listed, but sending a message fails | Read the actual error, check your network and the account's model permissions. If it asks for re-authorization, click **Authorize again**. |

## Build from source

Three scripts under `apps/desktop` cover the whole flow: **Build → Run → Package**. Run all commands from the repository root.

### Requirements

| Platform | What you need |
| --- | --- |
| macOS | Node.js and pnpm (versions in `apps/desktop/mise.toml`), Xcode Command Line Tools (`xcode-select --install`) |
| Windows x64 | Node.js 24.x on `PATH` (the scripts detect it automatically); pnpm 10.x is optional: if it is not on `PATH`, the scripts enable it through the corepack bundled with Node.js (needs network access the first time); if your tools live in a fixed directory that is not on `PATH`, set the `FCODE_TOOLCHAIN` environment variable, or create an untracked `toolchain.local.cmd` in `apps/desktop` containing `set "FCODE_TOOLCHAIN=your directory"` (the directory must contain `node24\node-v24.14.0-win-x64` and `pnpm\node_modules\.bin`) |

The first build runs `pnpm install --frozen-lockfile` automatically, so you do not need to install dependencies by hand.

### macOS

```bash
# 1. Build
./apps/desktop/build.sh

# 2. Run (starts the desktop app in development mode; press Ctrl+C to exit)
./apps/desktop/run.sh

# 3. Package (produces a .dmg, for the host architecture by default)
./apps/desktop/package.sh
```

Useful options:

```bash
./apps/desktop/build.sh --release    # build, then package; same as build.sh followed by package.sh
./apps/desktop/package.sh arm64      # pick the architecture: arm64 or x64
FCODE_ENABLE_MAC_SIGN=1 ./apps/desktop/package.sh   # sign only when a signing certificate is available; unsigned by default
```

### Windows

```powershell
# 1. Build
.\apps\desktop\build.cmd

# 2. Run (starts the desktop app in development mode; press Ctrl+C to exit)
.\apps\desktop\run.cmd

# 3. Package (produces an .exe installer; x64 only)
.\apps\desktop\package.cmd
```

Useful option:

```powershell
.\apps\desktop\build.cmd --release   # build, then package
```

You can also double-click the scripts inside `apps/desktop`.

### Notes on running

- Build before the first Run; Run tells you to run Build first if dependencies are missing.
- Run uses an isolated local data directory and does not modify any existing FCode data in your home directory (missing local settings are imported read-only once); no environment variables are needed.
- Run needs local port 5174 to be free; stop any previously started instance if it is in use.
- Keep the terminal open while it runs and press `Ctrl+C` to exit.

### Where installers are written

- Windows: `releases/windows/<version>/`, producing an `.exe` installer.
- macOS: `releases/macos/<version>/`, producing a `.dmg` plus a `.sha256` checksum file (the build also leaves a `.zip` for local use only; it is not published).

These directories are local build output, ignored by `.gitignore` and never committed. Installers for distribution are uploaded to [GitHub Releases](https://github.com/markusleevip/FCode/releases).

## Feedback and contributing

If you run into a problem or have a suggestion, please open an [issue](https://github.com/markusleevip/FCode/issues). Pull requests are welcome.

## Acknowledgements

FCode references the design and implementation of the ZCode project. We thank the ZCode project and its contributors.
This is an independently maintained project and is not affiliated with or endorsed by the ZCode project or its owners. "ZCode", "z.ai" and related names and marks belong to their respective owners.
Third-party components and their licenses are listed in [apps/desktop/THIRD-PARTY-NOTICES.md](apps/desktop/THIRD-PARTY-NOTICES.md).

## License

This project is released under the [Apache License 2.0](LICENSE).
