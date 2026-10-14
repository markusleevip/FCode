import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

struct DesktopFrame {
    let id: String
    let region: CGRect
    let topology: String
    let width: Int
    let height: Int
    let expires: Double
    let foreground: pid_t
    let launchDate: Date?
    let focus: AXUIElement?
    let windows: String
}

func desktopPrivatePID(_ pid: pid_t) -> Bool {
    if pid == getpid() || pid == getppid() { return true }
    let identifier = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
    return identifier.hasPrefix("dev.fcode.") || identifier.hasPrefix("com.fcode.")
}

func desktopFocus(_ pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.1)
    guard let raw = axValue(app, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    let element = raw as! AXUIElement
    AXUIElementSetMessagingTimeout(element, 0.1)
    return element
}

func desktopWindowVersion(_ region: CGRect) -> String {
    windowList().compactMap { window -> String? in
        guard let pid = window[kCGWindowOwnerPID as String] as? Int, !desktopPrivatePID(pid_t(pid)),
              window[kCGWindowLayer as String] as? Int != Int(CGWindowLevelForKey(.cursorWindow)),
              let raw = window[kCGWindowBounds as String] as? JSONObject,
              let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.intersects(region) else { return nil }
        return "\(window[kCGWindowNumber as String] ?? 0):\(pid):\(window[kCGWindowLayer as String] ?? 0):\(rect)"
    }.joined(separator: "|")
}

@MainActor func captureDesktop(_ displayId: CGDirectDisplayID) async throws -> (DesktopFrame, JSONObject) {
    try requireUnlockedSession()
    guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { throw ControlFailure("permission_required") }
    let topology = topologyVersion(), region = CGDisplayBounds(displayId)
    guard let foreground = NSWorkspace.shared.frontmostApplication, !desktopPrivatePID(foreground.processIdentifier) else {
        throw ControlFailure("control_busy", "Move FCode and private control windows out of the foreground before observing the desktop.")
    }
    let focus = desktopFocus(foreground.processIdentifier), windows = desktopWindowVersion(region)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayId }), display.frame == region else {
        throw ControlFailure("observation_stale", "Desktop capture display, focus, topology or window layout changed.")
    }
    let excluded = content.applications.filter { desktopPrivatePID($0.processID) }
    // Exclude every window of each private process, including panels created after enumeration.
    let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    let configuration = SCStreamConfiguration()
    let ratio = min(1, 1600 / max(region.width, region.height))
    configuration.width = max(1, Int((region.width * ratio).rounded()))
    configuration.height = max(1, Int((region.height * ratio).rounded()))
    configuration.scalesToFit = true
    configuration.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    try requireUnlockedSession()
    guard topology == topologyVersion(), region == CGDisplayBounds(displayId) else { throw ControlFailure("observation_stale", "Desktop capture display topology changed.") }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == foreground.processIdentifier else { throw ControlFailure("observation_stale", "Desktop capture foreground changed.") }
    guard desktopWindowVersion(region) == windows else { throw ControlFailure("observation_stale", "Desktop capture window layout changed.") }
    let freshFocus = desktopFocus(foreground.processIdentifier)
    guard (focus == nil && freshFocus == nil) || (focus != nil && freshFocus != nil && CFEqual(focus!, freshFocus!)) else {
        throw ControlFailure("observation_stale", "Desktop capture keyboard focus changed.")
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw ControlFailure("capture_failed") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination), data.length <= 4 * 1024 * 1024 else { throw ControlFailure("resource_limit") }
    let frame = DesktopFrame(id: UUID().uuidString, region: region, topology: topology, width: image.width,
        height: image.height, expires: monotonicNow() + 15, foreground: foreground.processIdentifier,
        launchDate: foreground.launchDate, focus: freshFocus, windows: windows)
    let result: JSONObject = ["image": ["mimeType": "image/png", "data": (data as Data).base64EncodedString()],
        "frameId": frame.id, "coordinateSpace": "desktop-image-pixels", "inputRouting": "foreground",
        "application": ["name": "macOS desktop"], "desktopObservation": ["id": frame.id,
            "displayId": String(displayId), "topologyVersion": topology, "width": frame.width, "height": frame.height,
            "region": regionJSON(region), "capturedAtMs": Int(Date().timeIntervalSince1970 * 1000),
            "foreground": ["application": foreground.localizedName ?? "Application"]]]
    return (frame, result)
}
