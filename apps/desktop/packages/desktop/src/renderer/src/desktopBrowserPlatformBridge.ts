import type { IPlatformService } from "@fcode/shared";

type DesktopBrowserPlatformBridge = Pick<
  IPlatformService,
  | "onBrowserViewReady"
  | "onBrowserViewOperation"
  | "onBrowserViewViewportChanged"
  | "onBrowserViewVisibility"
  | "onBrowserViewCloseTab"
  | "onBrowserViewSuspend"
  | "onBrowserViewRestore"
  | "browserViewAttachGuest"
  | "browserViewDetachGuest"
  | "browserViewCloseTab"
  | "browserViewReportResidency"
  | "browserViewSuspendReady"
  | "browserViewEnsureResident"
  | "browserViewRestoreTabs"
  | "browserViewUpdateViewport"
  | "importChromeBrowserData"
  | "clearEmbeddedBrowserData"
  | "getPathForFile"
  | "saveFile"
  | "printPageToPdf"
>;

// Rebase 集成：browser bridge 若继续内联在 renderer 入口，会让入口越过 max-lines 门禁。
// 独立对象只做 preload 委托与旧 bridge 兼容兜底，不持有 Browser 业务状态。
export const desktopBrowserPlatformBridge = {
  getPathForFile: (file) => window.fcode.getPathForFile?.(file) ?? null,
  saveFile: (payload) =>
    window.fcode.saveFile?.(payload) ?? Promise.resolve({ success: false, error: "not_supported" }),
  // 条件定义而非兜底返回失败：UI 靠方法是否存在做能力检测，旧 preload 下必须保持 undefined
  printPageToPdf: window.fcode.printPageToPdf ? () => window.fcode.printPageToPdf!() : undefined,
  onBrowserViewReady: (handler) => window.fcode.onBrowserViewReady?.(handler) ?? (() => {}),
  onBrowserViewOperation: (handler) => window.fcode.onBrowserViewOperation?.(handler) ?? (() => {}),
  onBrowserViewViewportChanged: (handler) =>
    window.fcode.onBrowserViewViewportChanged?.(handler) ?? (() => {}),
  onBrowserViewVisibility: (handler) =>
    window.fcode.onBrowserViewVisibility?.(handler) ?? (() => {}),
  onBrowserViewCloseTab: (handler) => window.fcode.onBrowserViewCloseTab?.(handler) ?? (() => {}),
  onBrowserViewSuspend: (handler) => window.fcode.onBrowserViewSuspend?.(handler) ?? (() => {}),
  onBrowserViewRestore: (handler) => window.fcode.onBrowserViewRestore?.(handler) ?? (() => {}),
  browserViewAttachGuest: (payload) =>
    window.fcode.browserViewAttachGuest?.(payload) ??
    Promise.resolve({ ok: false, reason: "not-found", recoveryRequested: false }),
  browserViewDetachGuest: (payload) =>
    window.fcode.browserViewDetachGuest?.(payload) ?? Promise.resolve(false),
  browserViewCloseTab: (payload) =>
    window.fcode.browserViewCloseTab?.(payload) ?? Promise.resolve(),
  browserViewReportResidency: (payload) =>
    window.fcode.browserViewReportResidency?.(payload) ?? Promise.resolve(),
  browserViewSuspendReady: (payload) =>
    window.fcode.browserViewSuspendReady?.(payload) ?? Promise.resolve(),
  browserViewEnsureResident: (payload) =>
    window.fcode.browserViewEnsureResident?.(payload) ?? Promise.resolve(),
  browserViewRestoreTabs: (payload) =>
    window.fcode.browserViewRestoreTabs?.(payload) ?? Promise.resolve([]),
  browserViewUpdateViewport: (payload) =>
    window.fcode.browserViewUpdateViewport?.(payload) ?? Promise.resolve(),
  importChromeBrowserData: (options) =>
    window.fcode.importChromeBrowserData?.(options) ??
    Promise.resolve({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "unsupported",
    }),
  clearEmbeddedBrowserData: (mode) =>
    window.fcode.clearEmbeddedBrowserData?.(mode) ??
    Promise.resolve({ success: false, error: "unsupported" }),
} satisfies DesktopBrowserPlatformBridge;
