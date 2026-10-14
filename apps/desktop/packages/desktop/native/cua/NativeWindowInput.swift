import AppKit
import ApplicationServices
import Darwin

private let nativeWindowInputSymbolAvailable: Bool = {
    guard let handle = dlopen(nil, RTLD_LAZY) else { return false }
    defer { dlclose(handle) }
    return dlsym(handle, "CGEventSetWindowLocation") != nil
}()

@MainActor enum NativeWindowInput {
    typealias WindowLocationSetter = @convention(c) (CGEvent, CGPoint) -> Void
    private static let windowLocation: WindowLocationSetter? = {
        guard let handle = dlopen(nil, RTLD_LAZY), let symbol = dlsym(handle, "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(symbol, to: WindowLocationSetter.self)
    }()
    // Empirically validated for window-addressed AppKit input; not a public mouse subtype.
    private static let windowAddressedMouseSubtype: Int64 = 3
    nonisolated static var available: Bool { nativeWindowInputSymbolAvailable }

    static func prepare(_ method: String, _ args: JSONObject, target: JSONObject, observations: ObservationStore,
                        input: InputControl, epoch: Int) throws -> BackgroundInput.Operation {
        guard ["click", "move", "drag", "scroll", "type_text", "press_keys"].contains(method) else {
            throw ControlFailure("unsupported_action", "This action cannot run without taking over the desktop.")
        }
        guard available, CGPreflightPostEventAccess() else {
            throw ControlFailure("unsupported_action", "Window-addressed background input is unavailable on this system.")
        }
        let state = try observations.find(string(args["frameId"] ?? args["stateId"], limit: 128), target: target)
        let app = try runningApp(target)
        let windowId = try integer(target["windowId"], min: 1)
        if ["type_text", "press_keys"].contains(method) {
            return try NativeWindowKeyboard.prepare(method, args, state: state, target: target,
                observations: observations, input: input, epoch: epoch, app: app, windowId: windowId)
        }
        let point = try mapPoint(state, x: args["x"], y: args["y"])
        let end = method == "drag" ? try mapPoint(state, x: args["toX"], y: args["toY"]) : point
        let duration = method == "drag" ? try integer(args["durationMs"] ?? 500, min: 100, max: 2000) : 0
        let count = method == "click" ? try integer(args["count"] ?? 1, min: 1, max: 3) : 1
        let dy = method == "scroll" ? try integer(args["deltaY"], min: -10000, max: 10000) : 0
        let dx = method == "scroll" ? try integer(args["deltaX"] ?? 0, min: -10000, max: 10000) : 0
        let name = args["button"] as? String ?? "left"
        let down: NSEvent.EventType = name == "right" ? .rightMouseDown : name == "middle" ? .otherMouseDown : .leftMouseDown
        let up: NSEvent.EventType = name == "right" ? .rightMouseUp : name == "middle" ? .otherMouseUp : .leftMouseUp
        return BackgroundInput.Operation { markStarted in
            @MainActor func validate() throws {
                _ = try observations.find(state.id, target: target)
                _ = try runningApp(target)
                try input.check(epoch)
            }
            @MainActor func send(_ type: NSEvent.EventType, _ position: CGPoint, clickCount: Int = 1,
                      hold: String? = nil, releaseType: NSEvent.EventType? = nil) throws {
                try validate()
                let event = try mouse(type, point: position, state: state, windowId: windowId, count: clickCount)
                let release = try releaseType.map { try mouse($0, point: position, state: state, windowId: windowId, count: clickCount) }
                try input.postWindow(event, to: app, epoch: epoch, heldId: hold, release: release, markStarted: markStarted)
            }
            if method == "move" { try send(.mouseMoved, point) }
            else if method == "click" {
                for clickCount in 1...count {
                    try send(down, point, clickCount: clickCount, hold: "mouse:\(windowId):\(name)", releaseType: up)
                    try send(up, point, clickCount: clickCount, hold: "mouse:\(windowId):\(name)")
                    usleep(40000)
                }
            } else if method == "scroll" {
                try validate()
                let event = try mouse(.mouseMoved, point: point, state: state, windowId: windowId)
                event.type = .scrollWheel
                event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                event.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64(-dy))
                event.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: Int64(-dx))
                event.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(-dy))
                event.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(-dx))
                event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(-dy))
                event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(-dx))
                try input.postWindow(event, to: app, epoch: epoch, markStarted: markStarted)
            } else {
                try send(.leftMouseDown, point, hold: "mouse:\(windowId):left", releaseType: .leftMouseUp)
                for step in 1...20 {
                    let ratio = Double(step) / 20
                    let next = CGPoint(x: point.x + (end.x - point.x) * ratio, y: point.y + (end.y - point.y) * ratio)
                    try send(.leftMouseDragged, next, hold: "mouse:\(windowId):left", releaseType: .leftMouseUp)
                    usleep(useconds_t(duration * 1000 / 20))
                }
                try send(.leftMouseUp, end, hold: "mouse:\(windowId):left")
            }
            return ["status": "dispatched", "effectVerified": false, "inputRouting": "background",
                "inputBackend": "native-window-events", "operationPointerReceipt": ["target": pointerTarget(target),
                    "region": regionJSON(state.region), "topologyVersion": state.topology, "space": "screen",
                    "x": end.x, "y": end.y, "kind": "pointer", "phase": method == "click" ? "click" : method == "drag" ? "drag" : "position",
                    "updatedAt": Date().timeIntervalSince1970 * 1000]]
        }
    }

    private static func mouse(_ type: NSEvent.EventType, point: CGPoint, state: WindowObservation,
                              windowId: Int, count: Int = 1) throws -> CGEvent {
        let local = CGPoint(x: point.x - state.region.minX, y: point.y - state.region.minY)
        guard let setter = windowLocation,
              let event = NSEvent.mouseEvent(with: type, location: CGPoint(x: local.x, y: state.region.height - local.y),
                modifierFlags: [], timestamp: monotonicNow(), windowNumber: windowId, context: nil,
                eventNumber: 1, clickCount: count, pressure: 1)?.cgEvent else { throw ControlFailure("unsupported_action") }
        event.flags = []
        event.location = point
        setter(event, local)
        event.setIntegerValueField(.mouseEventSubtype, value: windowAddressedMouseSubtype)
        event.setIntegerValueField(.mouseEventButtonNumber, value: [.rightMouseDown, .rightMouseUp, .rightMouseDragged].contains(type) ? 1 :
            [.otherMouseDown, .otherMouseUp, .otherMouseDragged].contains(type) ? 2 : 0)
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
        return event
    }
}
