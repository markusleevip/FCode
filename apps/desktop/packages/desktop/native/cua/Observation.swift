import AppKit
import ApplicationServices
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Darwin

struct WindowObservation {
    let id: String
    let target: JSONObject
    let region: CGRect
    let topology: String
    let width: Int
    let height: Int
    let expiresAt: Double
    let elements: [AXUIElement]
    let descriptions: [JSONObject]
}

final class ObservationStore {
    private var observations: [String: WindowObservation] = [:]

    func reset() { observations.removeAll() }

    func find(_ id: String, target: JSONObject) throws -> WindowObservation {
        guard let state = observations[id] else { throw ControlFailure("observation_stale", "The native observation is no longer registered.") }
        guard state.expiresAt > monotonicNow() else { throw ControlFailure("observation_stale", "The native observation expired before input.") }
        guard state.target["instanceId"] as? String == target["instanceId"] as? String,
              state.target["windowId"] as? Int == target["windowId"] as? Int else {
            throw ControlFailure("observation_stale", "The native observation belongs to another target instance.")
        }
        guard state.region == (try windowRegion(target)) else {
            throw ControlFailure("observation_stale", "The native window geometry changed after observation.")
        }
        guard state.topology == topologyVersion() else { throw ControlFailure("observation_stale", "The display topology changed after observation.") }
        return state
    }

    @MainActor func capture(target: JSONObject, includeElements: Bool, previewOnly: Bool = false) async throws -> JSONObject {
        for attempt in 0..<2 {
            do { return try await captureOnce(target: target, includeElements: includeElements, previewOnly: previewOnly) }
            catch let failure as ControlFailure where failure.code == "capture_space_changed" {
                guard attempt == 0, target["pid"] as? Int == Int(getpid()) else {
                    throw ControlFailure("observation_stale", failure.message)
                }
                // Capture again with fresh bounds; never retry an input or relax target identity.
            }
        }
        throw ControlFailure("observation_stale")
    }

    @MainActor private func captureOnce(target: JSONObject, includeElements: Bool, previewOnly: Bool) async throws -> JSONObject {
        guard CGPreflightScreenCaptureAccess() else { throw ControlFailure("screen_recording_required") }
        let pid = try integer(target["pid"], min: 1)
        let windowId = try integer(target["windowId"], min: 1)
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { Int($0.windowID) == windowId && Int($0.owningApplication?.processID ?? 0) == pid }) else {
            throw ControlFailure("target_changed")
        }
        let region = try windowRegion(target)
        let topology = topologyVersion()
        guard window.frame == region else {
            throw ControlFailure("capture_space_changed", "The native and shareable window bounds disagree.")
        }
        let displayFilteringAvailable: Bool
        if #available(macOS 14.2, *) { displayFilteringAvailable = true }
        else { displayFilteringAvailable = false }
        let geometry = try WindowCaptureGeometry.make(region: region, displays: content.displays.map(\.frame),
            onScreen: window.isOnScreen, displayFilteringAvailable: displayFilteringAvailable, previewOnly: previewOnly)
        let configuration = SCStreamConfiguration()
        configuration.width = geometry.width
        configuration.height = geometry.height
        configuration.scalesToFit = true
        configuration.destinationRect = geometry.destinationRect
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.captureResolution = .nominal
        let filter: SCContentFilter
        if #available(macOS 14.2, *), let index = geometry.displayIndex, let sourceRect = geometry.sourceRect {
            let display = content.displays[index]
            guard display.frame == CGDisplayBounds(display.displayID) else {
                throw ControlFailure("capture_space_changed", "The selected display geometry changed before capture.")
            }
            // An open AppKit popup can alias its parent's surface in desktop-independent capture.
            // Filter only the authorized window and crop exactly its region in display-local points.
            filter = SCContentFilter(display: display, including: [window])
            filter.includeMenuBar = false
            configuration.includeChildWindows = false
            configuration.ignoreShadowsDisplay = true
            configuration.sourceRect = sourceRect
        } else {
            filter = SCContentFilter(desktopIndependentWindow: window)
        }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard image.width == geometry.width, image.height == geometry.height else {
            throw ControlFailure("capture_failed", "The native image dimensions do not match the capture space.")
        }
        try requireUnlockedSession()
        try validateCaptureSpace(target: target, region: region, topology: topology)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw ControlFailure("capture_failed")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), data.length <= 20 * 1024 * 1024 else {
            throw ControlFailure("resource_limit")
        }
        if previewOnly {
            guard data.length <= 4 * 1024 * 1024 else { throw ControlFailure("resource_limit") }
            return ["image": ["mimeType": "image/png", "data": (data as Data).base64EncodedString()],
                    "previewFrameGeometry": previewFrameGeometry(target, region: region, topology: topology, width: image.width, height: image.height)]
        }
        var handles: [AXUIElement] = []
        var descriptions: [JSONObject] = []
        var truncationReason: String?
        if includeElements {
            guard AXIsProcessTrusted() else { throw ControlFailure("accessibility_required") }
            if pid == Int(getpid()) {
                // Self AX queries must leave the AppKit/WebKit run loop available to service accessibility.
                let result = try await Task.detached { try collectWindowElements(target) }.value
                handles = result.handles
                descriptions = result.descriptions
                truncationReason = result.truncationReason
            } else {
                let result = try collectWindowElements(target)
                handles = result.handles
                descriptions = result.descriptions
                truncationReason = result.truncationReason
            }
        }
        try requireUnlockedSession()
        try validateCaptureSpace(target: target, region: region, topology: topology)
        let id = UUID().uuidString
        observations = observations.filter { $0.value.expiresAt > monotonicNow() }
        if observations.count >= 32 { observations.removeValue(forKey: observations.keys.sorted().first!) }
        observations[id] = WindowObservation(id: id, target: target, region: region, topology: topology,
            width: image.width, height: image.height, expiresAt: monotonicNow() + 15, elements: handles, descriptions: descriptions)
        return ["observation": ["id": id, "target": target, "width": image.width, "height": image.height,
            "region": regionJSON(region), "topologyVersion": topology, "elements": descriptions,
            "elementsTruncated": truncationReason != nil, "elementsTruncationReason": truncationReason as Any? ?? NSNull()]
            .merging(targetForegroundState(target)) { _, current in current },
            "image": ["mimeType": "image/png", "data": (data as Data).base64EncodedString()],
            "previewFrameGeometry": previewFrameGeometry(target, region: region, topology: topology, width: image.width, height: image.height)]
    }
}

private func validateCaptureSpace(target: JSONObject, region: CGRect, topology: String) throws {
    _ = try resolveTarget(target)
    let geometryChanged = region != (try windowRegion(target))
    let topologyChanged = topology != topologyVersion()
    guard !geometryChanged && !topologyChanged else {
        throw ControlFailure("capture_space_changed", "Capture space changed (geometry: \(geometryChanged), topology: \(topologyChanged)).")
    }
}

func runningApp(_ value: JSONObject) throws -> NSRunningApplication {
    let pid = try integer(value["pid"], min: 1)
    let appId = try string(value["appId"], limit: 512)
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated,
          app.bundleIdentifier == appId, app.executableURL != nil else {
        throw ControlFailure("target_changed")
    }
    return app
}

func appJSON(_ app: NSRunningApplication) throws -> JSONObject {
    guard let appId = app.bundleIdentifier, let executable = app.executableURL else {
        throw ControlFailure("target_changed")
    }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(app.processIdentifier, PROC_PIDTBSDINFO, 0, &info, size) == size else {
        throw ControlFailure("target_changed")
    }
    return ["appId": appId, "pid": Int(app.processIdentifier), "name": app.localizedName ?? appId,
        "instanceId": "\(app.processIdentifier):\(info.pbi_start_tvsec):\(info.pbi_start_tvusec):\(executable.resolvingSymlinksInPath().path)"]
}

func windowList(includeOffscreen: Bool = false) -> [JSONObject] {
    let scope: CGWindowListOption = includeOffscreen ? .optionAll : .optionOnScreenOnly
    return (CGWindowListCopyWindowInfo([scope, .excludeDesktopElements], kCGNullWindowID) as? [JSONObject]) ?? []
}

func windowRegion(_ target: JSONObject) throws -> CGRect {
    let window = try windowDescription(target)
    guard let bounds = window[kCGWindowBounds as String] as? JSONObject,
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0 else {
        throw ControlFailure("target_changed")
    }
    return rect
}

func topologyVersion() -> String {
    var displays = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &displays, &count) == .success else { return "unknown" }
    return displays.prefix(Int(count)).sorted().map { id in
        let r = CGDisplayBounds(id)
        return "\(id):\(r.minX):\(r.minY):\(r.width):\(r.height):\(CGDisplayPixelsWide(id)): \(CGDisplayPixelsHigh(id))"
    }.joined(separator: "|")
}

func resolveTarget(_ params: JSONObject) throws -> JSONObject {
    let app = try runningApp(params)
    var target = try appJSON(app)
    if let expected = params["instanceId"] as? String, expected != target["instanceId"] as? String {
        throw ControlFailure("target_changed")
    }
    if let windowId = params["windowId"] {
        target["windowId"] = try integer(windowId, min: 1)
        target["region"] = regionJSON(try windowRegion(target))
        target["topologyVersion"] = topologyVersion()
    }
    return target
}

func ensureFocused(_ target: JSONObject, point: CGPoint? = nil) throws {
    let app = try runningApp(target)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        throw ControlFailure("focus_changed")
    }
    let region = try windowRegion(target)
    let id = try integer(target["windowId"], min: 1)
    let windows = windowList().filter { ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0 }
    if let point {
        guard region.contains(point) else { throw ControlFailure("invalid_request") }
        // CG bounds include full-display transparent Dock overlays. AX hit testing follows the actual input surface.
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.25)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { throw ControlFailure("window_occluded", "The OS could not resolve the input surface.") }
        var hitPID: pid_t = 0
        guard AXUIElementGetPid(hit, &hitPID) == .success, hitPID == app.processIdentifier else {
            throw ControlFailure("window_occluded", "The input surface belongs to another application.")
        }
        var current: AXUIElement? = hit
        var matchesWindow = false
        for _ in 0..<30 {
            guard let element = current else { break }
            AXUIElementSetMessagingTimeout(element, 0.1)
            if axValue(element, kAXRoleAttribute) as? String == kAXWindowRole {
                matchesWindow = axRegion(element) == region
                break
            }
            if let value = axValue(element, kAXWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
                current = (value as! AXUIElement)
            } else if let value = axValue(element, kAXParentAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
                current = (value as! AXUIElement)
            } else { break }
        }
        guard matchesWindow else { throw ControlFailure("window_occluded", "The input element does not belong to the observed window.") }
        // AX can lag a newly raised window. Cross-check z-order, exempting only the known transparent Dock surface.
        var reachedTarget = false
        for window in windows {
            guard let bounds = window[kCGWindowBounds as String] as? JSONObject,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.contains(point),
                  let ownerPID = window[kCGWindowOwnerPID as String] as? Int else { continue }
            if window[kCGWindowNumber as String] as? Int == id { reachedTarget = true; break }
            if ownerPID == Int(getpid()) { continue }
            let owner = NSRunningApplication(processIdentifier: pid_t(ownerPID))
            let isTransparentDock = owner?.bundleIdentifier == "com.apple.dock" &&
                window[kCGWindowName as String] as? String == "Dock" &&
                window[kCGWindowLayer as String] as? Int == 20 && NSScreen.screens.contains { screen in
                    guard let display = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
                    return CGDisplayBounds(display.uint32Value) == rect
                }
            if !isTransparentDock {
                let identity = owner?.bundleIdentifier ?? "unknown"
                let windowId = window[kCGWindowNumber as String] as? Int ?? -1
                let layer = window[kCGWindowLayer as String] as? Int ?? -1
                throw ControlFailure("window_occluded", "Input is covered by \(identity) window \(windowId) at layer \(layer).")
            }
        }
        guard reachedTarget else { throw ControlFailure("window_occluded", "The observed window is absent from the input stack.") }
    } else {
        let first = windows.first { $0[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier) &&
            $0[kCGWindowLayer as String] as? Int == 0 }
        guard first?[kCGWindowNumber as String] as? Int == id else { throw ControlFailure("focus_changed") }
    }
}

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success else { return nil }
    return result
}

func axRegion(_ element: AXUIElement) -> CGRect? {
    guard let p = axValue(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = axValue(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}


func targetForegroundState(_ target: JSONObject) -> JSONObject {
    guard let identifier = try? integer(target["pid"], min: 1, max: Int(Int32.max)),
          let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
        return ["targetAppIsForeground": NSNull(), "targetWindowIsForeground": NSNull()]
    }
    let pid = pid_t(identifier)
    if foreground != pid { return ["targetAppIsForeground": false, "targetWindowIsForeground": false] }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    guard let window = axValue(app, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID(),
          let expected = try? uniqueAXWindow(target) else {
        return ["targetAppIsForeground": true, "targetWindowIsForeground": NSNull()]
    }
    return ["targetAppIsForeground": true, "targetWindowIsForeground": CFEqual(window, expected)]
}
