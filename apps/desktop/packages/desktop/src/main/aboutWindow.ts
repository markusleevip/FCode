interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  versionLabel: string;
  okButtonLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 64px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .app-logo {
        width: 64px;
        height: 64px;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="64"
              height="64"
              viewBox="0 0 512 512"
              class="app-logo"
              focusable="false"
            >
              <defs>
                <linearGradient id="about-icon-background" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#152B43" />
                  <stop offset="1" stop-color="#131A34" />
                </linearGradient>
                <linearGradient id="about-icon-symbol" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#42E5CC" />
                  <stop offset="0.55" stop-color="#53B9F5" />
                  <stop offset="1" stop-color="#8586F6" />
                </linearGradient>
              </defs>
              <rect
                x="24"
                y="24"
                width="464"
                height="464"
                rx="108"
                fill="url(#about-icon-background)"
                stroke="#3C6780"
                stroke-opacity="0.75"
                stroke-width="4"
              />
              <path
                d="M162 368 V166 Q162 147 181 147 H370"
                fill="none"
                stroke="url(#about-icon-symbol)"
                stroke-width="43"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M162 260 H302"
                fill="none"
                stroke="url(#about-icon-symbol)"
                stroke-width="43"
                stroke-linecap="round"
              />
              <circle cx="370" cy="147" r="22" fill="#72E7D1" />
              <circle cx="302" cy="260" r="22" fill="#7D9FF7" />
              <path
                d="M343 328 L357 359 L388 373 L357 387 L343 418 L329 387 L298 373 L329 359 Z"
                fill="#77B8F8"
              />
            </svg>
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
