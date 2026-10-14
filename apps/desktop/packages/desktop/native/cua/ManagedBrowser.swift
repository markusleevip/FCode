import AppKit
import WebKit

final class ManagedBrowserWindow: NSWindow {
    var humanControl = false
    override var canBecomeKey: Bool { humanControl }
    override var canBecomeMain: Bool { humanControl }
}

final class ManagedWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor final class ManagedBrowser: NSObject, WKNavigationDelegate, WKUIDelegate {
    let credentials = CredentialStore()
    private(set) var window: ManagedBrowserWindow?
    private(set) var view: ManagedWebView?
    private var previousForeground: NSRunningApplication?

    func open(_ rawURL: String) throws -> JSONObject {
        guard window == nil else { throw ControlFailure("control_busy", "This task already owns a browser window.") }
        guard let url = URL(string: rawURL), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else {
            throw ControlFailure("invalid_request", "An HTTP(S) URL without embedded credentials is required.")
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let web = ManagedWebView(frame: NSRect(x: 0, y: 0, width: 1024, height: 768), configuration: configuration)
        let win = ManagedBrowserWindow(contentRect: NSRect(x: 80, y: 80, width: 1024, height: 768),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        win.title = "FCode Computer Window"
        win.setAccessibilityIdentifier("fcode-managed-window:\(win.windowNumber)")
        win.isReleasedWhenClosed = false
        win.ignoresMouseEvents = true
        web.autoresizingMask = [.width, .height]
        win.contentView = web
        web.navigationDelegate = self
        web.uiDelegate = self
        window = win
        view = web
        win.orderBack(nil)
        web.load(URLRequest(url: url))
        var target = try appJSON(NSRunningApplication.current)
        target["windowId"] = win.windowNumber
        target["title"] = win.title
        return ["target": target, "inputBackend": "native-owned-webkit", "browser": metadata]
    }

    func owns(_ target: JSONObject) -> Bool {
        target["pid"] as? Int == Int(getpid()) && target["windowId"] as? Int == window?.windowNumber
    }

    var metadata: JSONObject {
        var value: JSONObject = ["managed": true, "loading": view?.isLoading ?? false,
            "persistentWebsiteData": false]
        if let url = view?.url, let scheme = url.scheme, let host = url.host {
            let port = url.port.flatMap { number -> String? in
                if (scheme == "https" && number == 443) || (scheme == "http" && number == 80) { return nil }
                return ":\(number)"
            } ?? ""
            value["origin"] = "\(scheme.lowercased())://\(host.lowercased())\(port)"
        }
        value["credentialStatus"] = credentials.status
        return value
    }

    func controlUI(_ mode: String) throws -> JSONObject {
        try requireUnlockedSession()
        guard let window else { throw ControlFailure("target_changed") }
        if mode == "show" { window.orderFrontRegardless() }
        else if mode == "handover" {
            credentials.clear()
            if !window.humanControl,
               let foreground = NSWorkspace.shared.frontmostApplication, foreground.processIdentifier != getpid() {
                previousForeground = foreground
            }
            window.humanControl = true
            window.ignoresMouseEvents = false
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else if mode == "background" {
            window.humanControl = false
            window.ignoresMouseEvents = true
            if window.isKeyWindow { window.resignKey() }
            if window.isMainWindow { window.resignMain() }
            window.orderBack(nil)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
                _ = previousForeground?.activate(options: [.activateIgnoringOtherApps])
            }
            previousForeground = nil
        } else { throw ControlFailure("invalid_request") }
        return ["status": mode]
    }

    func previewTarget() throws -> JSONObject {
        guard let window else { throw ControlFailure("target_changed") }
        var target = try appJSON(NSRunningApplication.current)
        target["windowId"] = window.windowNumber
        return try resolveTarget(target)
    }

    func close() { credentials.clear(); window?.close(); view = nil; window = nil; previousForeground = nil }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        if navigationAction.targetFrame?.isMainFrame == true { credentials.clear() }
        decisionHandler(["http", "https", "about"].contains(scheme) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}
