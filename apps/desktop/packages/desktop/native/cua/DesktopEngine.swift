import AppKit
import ApplicationServices
import Carbon

@MainActor final class DesktopEngine {
    private let input: InputControl
    nonisolated let takeover: DesktopTakeover
    private var scope: (id: String, display: CGDirectDisplayID, epoch: Int, topology: String)?
    private var frame: DesktopFrame?
    private var actions = Set<String>()
    init(input: InputControl) { self.input = input; takeover = DesktopTakeover(input: input) }
    func reset() { scope = nil; frame = nil; actions.removeAll(); takeover.stop() }

    func displays(_ params: JSONObject) throws -> JSONObject {
        _ = try record(params, fields: [])
        try requireUnlockedSession()
        let id = CGMainDisplayID()
        return ["displays": [["displayId": String(id), "primary": true, "region": regionJSON(CGDisplayBounds(id))]],
            "topologyVersion": topologyVersion()]
    }

    func authorize(_ params: JSONObject) throws -> JSONObject {
        _ = try record(params, fields: ["scopeId", "displayId", "epoch"])
        let id = try string(params["scopeId"], limit: 128), display = try string(params["displayId"], limit: 128)
        let epoch = try integer(params["epoch"], min: 1)
        try input.check(epoch)
        guard display == String(CGMainDisplayID()), scope == nil else { throw ControlFailure("not_authorized") }
        try takeover.start()
        try input.check(epoch)
        scope = (id, CGMainDisplayID(), epoch, topologyVersion())
        return ["status": "authorized"]
    }

    func execute(_ params: JSONObject) async throws -> JSONObject {
        _ = try record(params, fields: ["action", "epoch", "revision", "callId", "desktopScope"])
        let epoch = try integer(params["epoch"], min: 1)
        _ = try integer(params["revision"])
        _ = try string(params["callId"], limit: 128)
        guard let scope, scope.id == (try string(params["desktopScope"], limit: 128)), scope.epoch == epoch else {
            throw ControlFailure("not_authorized")
        }
        try checkScope()
        let action = try record(params["action"], fields: ["schemaVersion", "actionId", "method", "params"])
        guard try integer(action["schemaVersion"]) == 2 else { throw ControlFailure("invalid_request") }
        let id = try string(action["actionId"], limit: 128), method = try string(action["method"], limit: 32)
        let args = try arguments(method, action["params"])
        guard !actions.contains(id) else { throw ControlFailure("not_authorized", "Desktop actions cannot be replayed.") }
        guard actions.count < 512 else { throw ControlFailure("resource_limit") }
        actions.insert(id)
        if method == "desktop_get_state" {
            frame = nil
            if let selected = args["displayId"] { guard try string(selected) == String(scope.display) else { throw ControlFailure("not_authorized") } }
            for attempt in 0..<3 {
                do {
                    let (observed, result) = try await captureDesktop(scope.display)
                    try checkScope(); frame = observed; return result
                } catch let error as ControlFailure where ["observation_stale", "control_busy"].contains(error.code) && attempt < 2 {
                    // Wait for foreground handoff and recording indicators. Retry observations only.
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            throw ControlFailure("observation_stale")
        }
        let observed = frame
        frame = nil
        guard let observed, observed.id == (try string(args["frameId"], limit: 128)), observed.expires > monotonicNow(),
              observed.topology == topologyVersion(), observed.region == CGDisplayBounds(scope.display) else { throw ControlFailure("observation_stale", "Desktop input frame is consumed, expired or belongs to changed display geometry.") }
        guard let foreground = NSWorkspace.shared.frontmostApplication, foreground.processIdentifier == observed.foreground,
              foreground.launchDate == observed.launchDate, !desktopPrivatePID(foreground.processIdentifier) else { throw ControlFailure("observation_stale", "Desktop input foreground application changed.") }
        guard observed.windows == desktopWindowVersion(observed.region) else { throw ControlFailure("observation_stale", "Desktop input window layout changed.") }
        try noPhysicalModifiers()
        let keyboard = ["desktop_type_text", "desktop_press_keys"].contains(method)
        if keyboard { try checkKeyboard(observed, needsReceiver: method == "desktop_type_text") }
        let point = try args["x"].map { _ in try map(observed, args["x"], args["y"]) }
        let destination = try args["toX"].map { _ in try map(observed, args["toX"], args["toY"]) }
        if let point { try checkPointer(point) }
        if let destination { try checkPointer(destination) }
        try input.begin(epoch)
        defer { input.finish() }
        let before = input.dispatchedCount
        do {
            if method == "desktop_type_text" {
                try input.text(string(args["text"]), epoch: epoch) { try self.checkScope(); try self.checkKeyboard(observed, needsReceiver: true) }
            } else if method == "desktop_press_keys" {
                try input.keys(args["keys"] as! [String], epoch: epoch)
            } else if method == "desktop_move" { try input.mouse(.mouseMoved, point: point!, epoch: epoch) }
            else if method == "desktop_click" {
                let button: CGMouseButton = args["button"] as? String == "right" ? .right : args["button"] as? String == "middle" ? .center : .left
                let down: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
                let up: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
                for count in 1...(try integer(args["count"] ?? 1, min: 1, max: 3)) {
                    try checkScope()
                    try checkPointer(point!)
                    try input.mouse(down, point: point!, button: button, epoch: epoch, count: count)
                    try input.mouse(up, point: point!, button: button, epoch: epoch, count: count)
                    usleep(40000)
                }
            } else if method == "desktop_scroll" {
                try input.mouse(.mouseMoved, point: point!, epoch: epoch)
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                    wheel1: Int32(-(try integer(args["deltaY"], min: -10000, max: 10000))),
                    wheel2: Int32(-(try integer(args["deltaX"] ?? 0, min: -10000, max: 10000))), wheel3: 0) else { throw ControlFailure("input_failed") }
                try checkScope(); try checkPointer(point!)
                try input.post(event, epoch: epoch)
            } else if method == "desktop_drag" {
                let duration = try integer(args["durationMs"] ?? 500, min: 100, max: 2000)
                try input.mouse(.leftMouseDown, point: point!, epoch: epoch)
                for step in 1...20 {
                    try checkScope()
                    let t = Double(step) / 20
                    let next = CGPoint(x: point!.x + (destination!.x - point!.x) * t, y: point!.y + (destination!.y - point!.y) * t)
                    try checkPointer(next)
                    try input.mouse(.leftMouseDragged, point: next, epoch: epoch)
                    usleep(useconds_t(duration * 1000 / 20))
                }
                try input.mouse(.leftMouseUp, point: destination!, epoch: epoch)
            }
            try checkScope()
            return ["status": "dispatched", "effectVerified": false, "inputRouting": "foreground", "inputBackend": "macos-cg-event"]
        } catch {
            guard before == input.dispatchedCount else {
                input.stop()
                throw ControlFailure("execution_uncertain", "Desktop input may be partial. Stop and observe; do not replay it.")
            }
            throw error
        }
    }

    private func checkScope() throws {
        guard let scope, !takeover.isInterrupted else { throw ControlFailure("canceled", "Desktop control was interrupted. Explicitly continue in a new task.") }
        try input.check(scope.epoch)
        guard scope.display == CGMainDisplayID(), scope.topology == topologyVersion() else { throw ControlFailure("observation_stale") }
    }

    private func noPhysicalModifiers() throws {
        let flags = CGEventSource.flagsState(.hidSystemState)
        guard flags.intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand]).isEmpty,
              !(0..<3).contains(where: { CGEventSource.buttonState(.hidSystemState, button: CGMouseButton(rawValue: UInt32($0))!) }) else {
            throw ControlFailure("control_busy", "Release physical modifiers and mouse buttons, then observe again.")
        }
    }

    private func checkPointer(_ point: CGPoint) throws {
        let window = windowList().first { window in
            guard window[kCGWindowLayer as String] as? Int != Int(CGWindowLevelForKey(.cursorWindow)),
                  let raw = window[kCGWindowBounds as String] as? JSONObject,
                  let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
            return rect.contains(point)
        }
        if let pid = window?[kCGWindowOwnerPID as String] as? Int, desktopPrivatePID(pid_t(pid)) {
            throw ControlFailure("not_authorized", "The pointer target is a private FCode or Helper interface.")
        }
    }

    private func checkKeyboard(_ observed: DesktopFrame, needsReceiver: Bool) throws {
        guard !IsSecureEventInputEnabled() else { throw ControlFailure("secure_input_active", "Secure keyboard input is active. Close the secure input interface and explicitly continue.") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == observed.foreground else { throw ControlFailure("observation_stale", "Keyboard foreground changed.") }
        let focused = desktopFocus(observed.foreground)
        guard (focused == nil && observed.focus == nil && !needsReceiver) ||
              (focused != nil && observed.focus != nil && CFEqual(focused!, observed.focus!)) else { throw ControlFailure("observation_stale", "Keyboard receiver changed or cannot be verified.") }
        if let focused {
            guard ![axValue(focused, kAXRoleAttribute) as? String, axValue(focused, kAXSubroleAttribute) as? String].contains(kAXSecureTextFieldSubrole) else {
                throw ControlFailure("not_authorized", "Secure fields require human input.")
            }
        }
    }

    private func map(_ frame: DesktopFrame, _ x: Any?, _ y: Any?) throws -> CGPoint {
        let x = try integer(x, max: frame.width - 1), y = try integer(y, max: frame.height - 1)
        return CGPoint(x: frame.region.minX + Double(x) * frame.region.width / Double(frame.width),
            y: frame.region.minY + Double(y) * frame.region.height / Double(frame.height))
    }

    private func arguments(_ method: String, _ raw: Any?) throws -> JSONObject {
        let rules: [String: (Set<String>, Set<String>)] = [
            "desktop_get_state": (["displayId"], []),
            "desktop_click": (["frameId", "x", "y", "button", "count"], ["frameId", "x", "y"]),
            "desktop_move": (["frameId", "x", "y"], ["frameId", "x", "y"]),
            "desktop_scroll": (["frameId", "x", "y", "deltaX", "deltaY"], ["frameId", "x", "y", "deltaY"]),
            "desktop_drag": (["frameId", "x", "y", "toX", "toY", "durationMs"], ["frameId", "x", "y", "toX", "toY"]),
            "desktop_type_text": (["frameId", "text"], ["frameId", "text"]),
            "desktop_press_keys": (["frameId", "keys"], ["frameId", "keys"])]
        guard let rule = rules[method] else { throw ControlFailure("unsupported_action") }
        let args = try record(raw, fields: rule.0, required: rule.1)
        for name in ["x", "y", "toX", "toY"] where args[name] != nil { _ = try integer(args[name], max: 100000) }
        for name in ["deltaX", "deltaY"] where args[name] != nil { _ = try integer(args[name], min: -10000, max: 10000) }
        if let count = args["count"] { _ = try integer(count, min: 1, max: 3) }
        if let duration = args["durationMs"] { _ = try integer(duration, min: 100, max: 2000) }
        if let button = args["button"] { guard ["left", "right", "middle"].contains(try string(button)) else { throw ControlFailure("invalid_request") } }
        if let text = args["text"] { _ = try string(text) }
        if let rawKeys = args["keys"] {
            guard let keys = rawKeys as? [String], !keys.isEmpty, keys.count <= 8, Set(keys).count == keys.count else { throw ControlFailure("invalid_request") }
            // Validate the entire key specification before any input is dispatched.
            try InputControl.validateKeys(keys)
        }
        return args
    }
}
