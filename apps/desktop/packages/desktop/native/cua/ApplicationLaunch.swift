import AppKit
import Foundation

@MainActor enum ApplicationLaunch {
    static func installed(_ appId: String) throws -> JSONObject {
        let url = try applicationURL(appId)
        let bundle = Bundle(url: url)!
        var result: JSONObject = ["appId": appId,
            "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ??
                bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? appId]
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == appId && !$0.isTerminated }
        guard running.count <= 1 else { throw ControlFailure("target_changed", "More than one application instance is running.") }
        if let existing = running.first { result["target"] = try appJSON(existing) }
        return result
    }

    static func open(_ appId: String, epoch: Int, input: InputControl) async throws -> JSONObject {
        try requireUnlockedSession()
        try input.begin(epoch)
        defer { input.finish() }
        let info = try installed(appId)
        if let target = info["target"] as? JSONObject { return ["target": target, "created": false] }
        let url = try applicationURL(appId)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = false
        configuration.promptsUserIfNeeded = false
        try input.check(epoch)
        let application = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        do {
            try input.check(epoch)
            try requireUnlockedSession()
            guard application.bundleIdentifier == appId, !application.isTerminated else {
                throw ControlFailure("target_changed", "The launched application identity changed before observation.")
            }
            return ["target": try appJSON(application), "created": true]
        } catch {
            input.stop()
            throw ControlFailure("execution_uncertain", "Application startup may have completed; do not replay it automatically.")
        }
    }

    private static func applicationURL(_ appId: String) throws -> URL {
        guard appId.utf8.count <= 256, appId.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]+$", options: .regularExpression) != nil,
              !appId.hasPrefix("dev.fcode."), appId != "com.google.Chrome",
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appId),
              url.pathExtension == "app", Bundle(url: url)?.bundleIdentifier == appId else {
            throw ControlFailure("application_unavailable", "A matching installed application could not be resolved.")
        }
        return url
    }
}
