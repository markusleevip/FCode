import { recordArmsCustomEventForE2E } from "@fcode/ui";
import { buildLocalMediaPreviewUrl, type IPlatformService } from "@fcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.fcode.selectDirectory(),
    selectFile: () => window.fcode.selectFile(),
    selectFiles: () => window.fcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.fcode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.fcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.fcode.onRemoteSessionClosed(handler),
    onBotRemoteWorkspaceReconnected: (handler) =>
      window.fcode.onBotRemoteWorkspaceReconnected(handler),
    activateOrSetWorkspace: (path) =>
      window.fcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.fcode.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.fcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.fcode.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    disposeRemoteSession: (sessionId) => window.fcode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.fcode.isDockerAvailable(),
    listWSLDistros: () => window.fcode.listWSLDistros(),
    listDockerContainers: () => window.fcode.listDockerContainers(),
    listSSHConfigAliases: () => window.fcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.fcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.fcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.fcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.fcode.openExternal(url),
    openInFileManager: (path) => window.fcode.openInFileManager(path),
    openExternalFile: (path) => window.fcode.openExternalFile(path),
    openCuaPermissionOnboarding: window.fcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.fcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.fcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.fcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.fcode.startCuaHelperPermissionDrag
      ? () => window.fcode.startCuaHelperPermissionDrag?.()
      : undefined,
    registerOAuthState: (payload) => window.fcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.fcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.fcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.fcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.fcode.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.fcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.fcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.fcode.getRendererActionTraceConfig
      ? () => window.fcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.fcode.onRendererActionTraceConfigChanged
      ? (callback) => window.fcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.fcode.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.fcode.reportRendererActionTraceBatch
      ? (batch) => window.fcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.fcode.reportRendererHeapSample
      ? (sample) => window.fcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.fcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.fcode.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.fcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.fcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.fcode.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.fcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.fcode.onFocusTab(handler),
    onNewTab: (handler) => window.fcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.fcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.fcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.fcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.fcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.fcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.fcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.fcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.fcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.fcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.fcode.getDesktopWindowChromeState
      ? () => window.fcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.fcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.fcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.fcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.fcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.fcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.fcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.fcode.onTaskNotificationClick(handler),
    exportLogs: () => window.fcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.fcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.fcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.fcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.fcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.fcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.fcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.fcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.fcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.fcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.fcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.fcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getFCodeStdioTapDevState: () =>
      window.fcode.getFCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.fcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.fcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.fcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.fcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.fcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.fcode.quitAndInstallUpdate(),
    getInstalledEditors: () => window.fcode.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.fcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.fcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.fcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.fcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.fcode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.fcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __FCODE_DEVICE_ID__?: string }).__FCODE_DEVICE_ID__ ?? "",
  };
}
