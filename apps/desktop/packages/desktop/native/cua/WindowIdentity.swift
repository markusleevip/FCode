import AppKit
import ApplicationServices
import Foundation

func windowDescription(_ target: JSONObject) throws -> JSONObject {
    let pid = try integer(target["pid"], min: 1)
    let id = try integer(target["windowId"], min: 1)
    guard let window = windowList(includeOffscreen: true).first(where: {
        $0[kCGWindowNumber as String] as? Int == id && $0[kCGWindowOwnerPID as String] as? Int == pid
    }) else { throw ControlFailure("target_changed") }
    return window
}

func uniqueAXWindow(_ target: JSONObject) throws -> AXUIElement {
    let app = try runningApp(target)
    let description = try windowDescription(target)
    let region = try windowRegion(target)
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(axApp, 0.25)
    guard let reportedWindows = axValue(axApp, kAXWindowsAttribute) as? [AXUIElement] else {
        throw ControlFailure("observation_stale", "The target AX windows could not be resolved.")
    }
    let windows = reportedWindows.isEmpty ? fallbackAXWindows(axApp, pid: app.processIdentifier) : reportedWindows
    if app.processIdentifier == getpid(), let id = target["windowId"] as? Int {
        // An owned window has a public native AX identifier independent of document title and other panels.
        let identifier = "fcode-managed-window:\(id)"
        let exact = windows.filter { axValue($0, kAXIdentifierAttribute) as? String == identifier }
        guard exact.count == 1, axRegion(exact[0]) == region else {
            let geometryMatches = exact.count == 1 && axRegion(exact[0]) == region
            throw ControlFailure("observation_stale", "The owned native window identifier and geometry do not match uniquely (matches: \(exact.count), geometryMatches: \(geometryMatches)).")
        }
        return exact[0]
    }
    let measured = windows.map { element -> (AXUIElement, CGRect?) in
        AXUIElementSetMessagingTimeout(element, 0.25)
        return (element, axRegion(element))
    }
    let candidates = measured.filter { $0.1 == region }.map { $0.0 }
    let geometryDiagnostic = "AX windows: \(reportedWindows.count), AX candidates: \(windows.count), AX matches: \(candidates.count), expected: \(region), AX regions: \(measured.compactMap { $0.1 })"
    let sameGeometry = windowList(includeOffscreen: true).filter { window in
        guard window[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier),
              window[kCGWindowLayer as String] as? Int == 0,
              let bounds = window[kCGWindowBounds as String] as? JSONObject else { return false }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary) == region
    }
    // A unique mapping on both sides is sufficient even when an app formats its AX title differently.
    if candidates.count == 1, sameGeometry.count == 1 { return candidates[0] }
    if reportedWindows.isEmpty {
        throw ControlFailure("observation_stale", "The fallback AX window and CG geometry are not unique (\(geometryDiagnostic)).")
    }
    let title = description[kCGWindowName as String] as? String ?? ""
    if !title.isEmpty {
        let matching = candidates.filter { axValue($0, kAXTitleAttribute) as? String == title }
        guard matching.count == 1 else {
            throw ControlFailure("observation_stale", "The target AX window title and geometry are not unique (\(geometryDiagnostic)).")
        }
        return matching[0]
    }
    guard candidates.count == 1, sameGeometry.count == 1 else {
        throw ControlFailure("observation_stale", "The untitled target AX window cannot be identified uniquely (\(geometryDiagnostic)).")
    }
    return candidates[0]
}

private func fallbackAXWindows(_ application: AXUIElement, pid: pid_t) -> [AXUIElement] {
    func element(_ owner: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let raw = axValue(owner, attribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return raw as! AXUIElement
    }
    var values = [element(application, kAXMainWindowAttribute), element(application, kAXFocusedWindowAttribute)]
    if let focused = element(application, kAXFocusedUIElementAttribute) {
        AXUIElementSetMessagingTimeout(focused, 0.25)
        values.append(element(focused, kAXWindowAttribute))
    }
    var candidates: [AXUIElement] = []
    for window in values.compactMap({ $0 }) {
        AXUIElementSetMessagingTimeout(window, 0.25)
        var actualPID: pid_t = 0
        guard AXUIElementGetPid(window, &actualPID) == .success, actualPID == pid,
              axValue(window, kAXRoleAttribute) as? String == kAXWindowRole,
              !candidates.contains(where: { CFEqual($0, window) }) else { continue }
        candidates.append(window)
    }
    return candidates
}
