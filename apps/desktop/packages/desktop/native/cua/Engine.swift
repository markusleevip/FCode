import AppKit
import ApplicationServices
import Foundation

@MainActor final class NativeEngine {
    let observations = ObservationStore()
    let input: InputControl
    let desktop: DesktopEngine
    let browser = ManagedBrowser()
    let chromeUi = NormalChromeWindowUi()
    let applicationUi = ApplicationWindowUi()
    let chromeCredentials = NormalChromeCredentials()
    private var ledger: [String: (Data, JSONObject)] = [:]

    init(input: InputControl) { self.input = input; desktop = DesktopEngine(input: input) }

    func execute(_ params: JSONObject) async throws -> JSONObject {
        try requireUnlockedSession()
        if params["desktopScope"] != nil { return try await desktop.execute(params) }
        guard browser.window?.humanControl != true else { throw ControlFailure("control_busy", "The user has taken control of this window.") }
        _ = try record(params, fields: ["action", "target", "epoch", "revision", "callId", "approved", "inputRouting"],
                       required: ["action", "epoch", "revision", "callId", "inputRouting"])
        let action = try record(params["action"], fields: ["schemaVersion", "actionId", "method", "params"])
        guard try integer(action["schemaVersion"]) == 1 else { throw ControlFailure("invalid_request") }
        let id = try string(action["actionId"], limit: 128)
        let method = try string(action["method"], limit: 32)
        let args = try validateArguments(method, action["params"])
        _ = try string(params["callId"], limit: 128)
        _ = try integer(params["revision"])
        let epoch = try integer(params["epoch"])
        let routing = try string(params["inputRouting"])
        guard ["background", "foreground"].contains(routing) else { throw ControlFailure("invalid_request") }
        let fingerprint = try JSONSerialization.data(withJSONObject: params, options: [.sortedKeys])
        if let previous = ledger[id] {
            guard previous.0 == fingerprint else { throw ControlFailure("invalid_request", "Action ID was reused.") }
            return previous.1
        }
        guard ledger.count < 512 else { throw ControlFailure("resource_limit") }
        let observe = ["list_apps", "list_windows", "capture", "get_app_state"].contains(method)
        if !observe {
            guard params["approved"] as? Bool == true else { throw ControlFailure("not_authorized") }
            try input.check(epoch)
            // Reserve before input. Unknown/partial effects cannot be replayed after an error.
            ledger[id] = (fingerprint, ["status": "execution_uncertain"])
        }
        let result: JSONObject
        if method == "list_apps" {
            result = ["apps": NSWorkspace.shared.runningApplications.filter {
                $0.activationPolicy == .regular || (browser.window != nil && $0.processIdentifier == getpid()) }
                .compactMap { try? appJSON($0) }]
        } else {
            guard let rawTarget = params["target"] as? JSONObject else { throw ControlFailure("not_authorized") }
            let target = try resolveTarget(rawTarget)
            if target["pid"] as? Int == Int(getpid()), !["open_browser", "list_windows"].contains(method), !browser.owns(target) {
                throw ControlFailure("not_authorized", "Private Helper windows cannot be accessed by the SDK.")
            }
            if method == "open_application" {
                result = ["target": target, "application": try appJSON(runningApp(target)), "status": "opened"]
            } else if method == "open_browser" {
                guard routing == "background", target["pid"] as? Int == Int(getpid()) else { throw ControlFailure("not_authorized") }
                try input.begin(epoch)
                defer { input.finish() }
                try input.check(epoch)
                result = try browser.open(string(args["url"], limit: 2048))
            } else if method == "list_windows" {
                let pid = try integer(target["pid"], min: 1)
                result = ["windows": windowList(includeOffscreen: true).filter { $0[kCGWindowOwnerPID as String] as? Int == pid &&
                    $0[kCGWindowLayer as String] as? Int == 0 &&
                    (pid != Int(getpid()) || $0[kCGWindowNumber as String] as? Int == browser.window?.windowNumber) }.compactMap { value -> JSONObject? in
                    guard let id = value[kCGWindowNumber as String] as? Int else { return nil }
                    var query = target
                    query["windowId"] = id
                    guard var window = try? resolveTarget(query) else { return nil }
                    window["title"] = value[kCGWindowName as String] as? String ?? ""
                    return window
                }]
            } else if method == "capture" || method == "get_app_state" {
                var captured = try await observations.capture(target: target, includeElements: method == "get_app_state")
                if browser.owns(target) { captured["browser"] = browser.metadata }
                else { captured["application"] = try appJSON(runningApp(target)) }
                result = captured
            } else if ["request_credential", "type_credential"].contains(method) {
                guard routing == "background", browser.owns(target) else { throw ControlFailure("not_authorized") }
                let state = try observations.find(string(args["stateId"], limit: 128), target: target)
                let index = try integer(args["elementIndex"], min: 0, max: state.elements.count - 1)
                let origin = try string(browser.metadata["origin"], limit: 2048)
                guard method != "request_credential" || args["origin"] as? String == origin else { throw ControlFailure("not_authorized") }
                let binding = try await Task.detached { try CredentialInput.binding(state, index: index, origin: origin) }.value
                guard browser.owns(target), browser.metadata["origin"] as? String == origin,
                      state.expiresAt > monotonicNow() else { throw ControlFailure("observation_stale") }
                try input.begin(epoch)
                defer { input.finish() }
                if method == "request_credential" {
                    result = try browser.credentials.request(binding, epoch: epoch, input: input)
                } else {
                    let value = try browser.credentials.take(string(args["credentialId"], limit: 128), binding: binding, epoch: epoch)
                    var dispatched = false
                    do {
                        for character in value {
                            let current = try await Task.detached { try CredentialInput.binding(state, index: index, origin: origin) }.value
                            guard current == binding, browser.metadata["origin"] as? String == origin else {
                                throw ControlFailure("observation_stale")
                            }
                            _ = try ManagedBrowserInput.execute("type_text", ["text": String(character)], target: target,
                                state: state, browser: browser, input: input, epoch: epoch) { dispatched = true }
                        }
                        result = ["status": "dispatched", "effectVerified": false, "credentialConsumed": true,
                            "inputRouting": "background", "inputBackend": "native-owned-webkit"]
                    } catch {
                        if !dispatched { throw error }
                        input.stop()
                        throw ControlFailure("execution_uncertain", "Credential input effects may be partial; the reference is consumed.")
                    }
                }
            } else {
                if routing == "background" {
                    if browser.owns(target) && ["click", "move", "type_text", "press_keys"].contains(method) {
                        let state = try observations.find(string(args["frameId"] ?? args["stateId"], limit: 128), target: target)
                        try input.begin(epoch)
                        defer { input.finish() }
                        var dispatched = false
                        do {
                            result = try ManagedBrowserInput.execute(method, args, target: target, state: state,
                                browser: browser, input: input, epoch: epoch) { dispatched = true }
                        } catch {
                            if !dispatched { throw error }
                            input.stop()
                            throw ControlFailure("execution_uncertain", "Owned-window input effects may be partial; observe before continuing.")
                        }
                        ledger[id] = (fingerprint, result)
                        return result
                    }
                    let operation = try method == "element_action"
                        ? BackgroundInput.prepare(method, args, target: target, observations: observations)
                        : NativeWindowInput.prepare(method, args, target: target, observations: observations, input: input, epoch: epoch)
                    try input.begin(epoch)
                    defer { input.finish() }
                    var dispatched = false
                    do { result = try operation.execute { dispatched = true } }
                    catch {
                        if !dispatched { throw error }
                        input.stop()
                        let code = (error as? ControlFailure)?.code ?? "input_failed"
                        throw ControlFailure("execution_uncertain", "Background input effects may be partial (\(code)); observe before continuing.")
                    }
                    ledger[id] = (fingerprint, result)
                    return result
                }
                // Reject a known pre-input mismatch without claiming unknown input effects.
                try preflight(method, args, target: target)
                try input.begin(epoch)
                defer { input.finish() }
                do { result = try perform(method, args, target: target, epoch: epoch) }
                catch {
                    input.stop()
                    let code = (error as? ControlFailure)?.code ?? "input_failed"
                    let detail = (error as? ControlFailure)?.message ?? code
                    throw ControlFailure("execution_uncertain", "Input may be partial (\(detail)); observe before continuing.")
                }
            }
        }
        if !observe { ledger[id] = (fingerprint, result) }
        return result
    }

    private func preflight(_ method: String, _ args: JSONObject, target: JSONObject) throws {
        if method == "activate_window" { return }
        let reference = try string(args["frameId"] ?? args["stateId"], limit: 128)
        let state = try observations.find(reference, target: target)
        if args["frameId"] != nil {
            try ensureFocused(target, point: mapPoint(state, x: args["x"], y: args["y"]))
        } else {
            try ensureFocused(target)
            if let rawIndex = args["elementIndex"] {
                let index = try integer(rawIndex, max: state.elements.count - 1)
                if let rect = axRegion(state.elements[index]) {
                    try ensureFocused(target, point: CGPoint(x: rect.midX, y: rect.midY))
                }
            }
        }
    }

    private func perform(_ method: String, _ args: JSONObject, target: JSONObject, epoch: Int) throws -> JSONObject {
        defer { input.stopOnExpiredLease() }
        if method == "activate_window" {
            let app = try runningApp(target)
            guard app.activate(options: []) else { throw ControlFailure("focus_changed") }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(axApp, 0.25)
            let region = try windowRegion(target)
            guard let windows = axValue(axApp, kAXWindowsAttribute) as? [AXUIElement],
                  let window = windows.first(where: { axRegion($0) == region }),
                  AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
                throw ControlFailure("unsupported_action")
            }
            return ["status": "dispatched"]
        }
        let reference = try string(args["frameId"] ?? args["stateId"], limit: 128)
        let state = try observations.find(reference, target: target)
        if args["frameId"] != nil {
            let point = try mapPoint(state, x: args["x"], y: args["y"])
            try ensureFocused(target, point: point)
            if method == "move" {
                try input.mouse(.mouseMoved, point: point, epoch: epoch)
            } else if method == "click" {
                let name = args["button"] as? String ?? "left"
                let button: CGMouseButton = name == "right" ? .right : name == "middle" ? .center : .left
                let down: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
                let up: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
                for count in 1...(try integer(args["count"] ?? 1, min: 1, max: 3)) {
                    try ensureFocused(target, point: point)
                    try input.mouse(down, point: point, button: button, epoch: epoch, count: count)
                    try input.mouse(up, point: point, button: button, epoch: epoch, count: count)
                    usleep(40000)
                }
            } else if method == "scroll" {
                try input.mouse(.mouseMoved, point: point, epoch: epoch)
                let dy = try integer(args["deltaY"], min: -10000, max: 10000)
                let dx = try integer(args["deltaX"] ?? 0, min: -10000, max: 10000)
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                          wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { throw ControlFailure("input_failed") }
                try ensureFocused(target, point: point)
                try input.post(event, epoch: epoch)
            } else if method == "drag" {
                let end = try mapPoint(state, x: args["toX"], y: args["toY"])
                let duration = try integer(args["durationMs"] ?? 500, min: 100, max: 2000)
                try input.mouse(.leftMouseDown, point: point, epoch: epoch)
                for step in 1...20 {
                    let t = Double(step) / 20
                    let next = CGPoint(x: point.x + (end.x - point.x) * t, y: point.y + (end.y - point.y) * t)
                    _ = try observations.find(reference, target: target)
                    try ensureFocused(target, point: next)
                    try input.mouse(.leftMouseDragged, point: next, epoch: epoch)
                    usleep(useconds_t(duration * 1000 / 20))
                }
                try input.mouse(.leftMouseUp, point: end, epoch: epoch)
            }
        } else {
            try ensureFocused(target)
            if let rawIndex = args["elementIndex"] {
                let index = try integer(rawIndex, max: state.elements.count - 1)
                let element = state.elements[index]
                if let rect = axRegion(element) { try ensureFocused(target, point: CGPoint(x: rect.midX, y: rect.midY)) }
                try input.check(epoch)
                if method == "element_action" {
                    let name = try string(args["action"])
                    let error: AXError
                    if name == "press" { error = AXUIElementPerformAction(element, kAXPressAction as CFString) }
                    else if name == "focus" { error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
                    else { error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, try string(args["value"], allowEmpty: true) as CFString) }
                    guard error == .success else { throw ControlFailure("unsupported_action") }
                } else {
                    guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                        throw ControlFailure("focus_changed")
                    }
                }
            }
            if method == "type_text" {
                try input.text(try string(args["text"]), epoch: epoch, validate: { try ensureFocused(target) })
            } else if method == "press_keys" {
                guard let keys = args["keys"] as? [String] else { throw ControlFailure("invalid_request") }
                try ensureFocused(target)
                try input.keys(keys, epoch: epoch)
            }
        }
        return ["status": "dispatched", "effectVerified": false]
    }
}

func mapPoint(_ state: WindowObservation, x: Any?, y: Any?) throws -> CGPoint {
    let x = try integer(x, max: state.width - 1)
    let y = try integer(y, max: state.height - 1)
    return CGPoint(x: state.region.minX + Double(x) * state.region.width / Double(state.width),
                   y: state.region.minY + Double(y) * state.region.height / Double(state.height))
}

func validateArguments(_ method: String, _ raw: Any?) throws -> JSONObject {
    let rules: [String: (Set<String>, Set<String>)] = [
        "list_apps": ([], []), "open_browser": (["url", "appId", "pid"], ["url", "appId", "pid"]),
        "open_application": (["appId", "pid"], ["appId", "pid"]),
        "list_windows": (["appId", "pid"], ["appId", "pid"]),
        "capture": (["appId", "pid", "windowId"], ["appId", "pid", "windowId"]),
        "get_app_state": (["appId", "pid", "windowId"], ["appId", "pid", "windowId"]),
        "activate_window": (["appId", "pid", "windowId"], ["appId", "pid", "windowId"]),
        "click": (["frameId", "x", "y", "button", "count"], ["frameId", "x", "y"]),
        "move": (["frameId", "x", "y"], ["frameId", "x", "y"]),
        "drag": (["frameId", "x", "y", "toX", "toY", "durationMs"], ["frameId", "x", "y", "toX", "toY"]),
        "scroll": (["frameId", "x", "y", "deltaX", "deltaY"], ["frameId", "x", "y", "deltaY"]),
        "type_text": (["stateId", "text", "elementIndex"], ["stateId", "text"]),
        "request_credential": (["stateId", "elementIndex", "origin"], ["stateId", "elementIndex", "origin"]),
        "type_credential": (["stateId", "elementIndex", "credentialId"], ["stateId", "elementIndex", "credentialId"]),
        "press_keys": (["stateId", "keys"], ["stateId", "keys"]),
        "element_action": (["stateId", "elementIndex", "action", "value"], ["stateId", "elementIndex", "action"])]
    guard let rule = rules[method] else { throw ControlFailure("unsupported_action") }
    let params = try record(raw, fields: rule.0, required: rule.1)
    if let button = params["button"] as? String, !["left", "right", "middle"].contains(button) { throw ControlFailure("invalid_request") }
    if method == "element_action" {
        let name = try string(params["action"])
        guard ["press", "focus", "set_value"].contains(name), (name == "set_value") == (params["value"] != nil) else {
            throw ControlFailure("invalid_request")
        }
    }
    return params
}
