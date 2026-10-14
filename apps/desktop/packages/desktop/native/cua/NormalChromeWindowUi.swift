import AppKit
import ApplicationServices

/** Private GUI controls; target binding and task ownership remain in trusted Main. */
@MainActor class ApplicationWindowUi {
    private var previousForeground: NSRunningApplication?
    private var retainedInstance: String?
    private let allowedAppId: String?

    init(allowedAppId: String? = nil) { self.allowedAppId = allowedAppId }

    func target(_ raw: JSONObject) throws -> JSONObject {
        _ = try record(raw, fields: ["appId", "pid", "windowId", "instanceId"], required: ["appId", "pid", "windowId"])
        let resolved = try resolveTarget(raw)
        let application = try runningApp(resolved)
        guard let appId = application.bundleIdentifier, !appId.hasPrefix("dev.fcode."),
              (allowedAppId == nil || allowedAppId == appId), application.processIdentifier != getpid() else {
            throw ControlFailure("not_authorized")
        }
        return resolved
    }

    func control(_ mode: String, target: JSONObject) throws -> JSONObject {
        try requireUnlockedSession()
        let resolved = try self.target(target)
        let application = try runningApp(resolved)
        if mode == "read" { return metadata(resolved, status: mode) }
        guard ["show", "handover", "background"].contains(mode) else { throw ControlFailure("invalid_request") }
        if mode == "background" {
            if retainedInstance == resolved["instanceId"] as? String,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier {
                _ = previousForeground?.activate(options: [])
            }
            previousForeground = nil
            retainedInstance = nil
            return metadata(resolved, status: mode)
        }
        let window = try uniqueAXWindow(resolved)
        if mode == "handover" {
            let foreground = NSWorkspace.shared.frontmostApplication
            if foreground?.processIdentifier != application.processIdentifier {
                previousForeground = foreground
                retainedInstance = resolved["instanceId"] as? String
            }
            guard application.activate(options: []) else { throw ControlFailure("focus_changed") }
        }
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
            throw ControlFailure("unsupported_action", "The application window could not be shown unambiguously.")
        }
        return metadata(resolved, status: mode)
    }

    private func metadata(_ target: JSONObject, status: String) -> JSONObject {
        var result = targetForegroundState(target)
        result["target"] = target
        result["status"] = status
        return result
    }
}

@MainActor final class NormalChromeWindowUi: ApplicationWindowUi {
    init() { super.init(allowedAppId: "com.google.Chrome") }
}
