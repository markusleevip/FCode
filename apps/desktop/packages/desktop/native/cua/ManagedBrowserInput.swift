import AppKit
import ApplicationServices

@MainActor enum ManagedBrowserInput {
    static func execute(_ method: String, _ args: JSONObject, target: JSONObject, state: WindowObservation,
                        browser: ManagedBrowser, input: InputControl, epoch: Int, markStarted: () -> Void) throws -> JSONObject {
        guard browser.owns(target), let window = browser.window, !window.isKeyWindow, !window.isMainWindow else {
            throw ControlFailure("control_busy", "The owned browser window is not available for background control.")
        }
        guard ["click", "move", "type_text", "press_keys"].contains(method) else { throw ControlFailure("unsupported_action") }
        let validate = {
            try input.check(epoch)
            try requireUnlockedSession()
            guard browser.owns(target), !window.isKeyWindow, !window.isMainWindow,
                  state.region == (try windowRegion(target)), state.topology == topologyVersion(),
                  state.expiresAt > monotonicNow() else { throw ControlFailure("observation_stale") }
        }
        try validate()
        if method == "click" || method == "move" {
            let global = try mapPoint(state, x: args["x"], y: args["y"])
            let point = window.convertPoint(fromScreen: NSPoint(x: global.x,
                y: (NSScreen.screens.first?.frame.maxY ?? 0) - global.y))
            let button = args["button"] as? String ?? "left"
            let down: NSEvent.EventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
            let up: NSEvent.EventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
            let count = try integer(args["count"] ?? 1, min: 1, max: 3)
            for click in 1...count {
                try validate()
                let kinds: [NSEvent.EventType] = method == "move" ? [.mouseMoved] : [down, up]
                for kind in kinds {
                    guard let event = NSEvent.mouseEvent(with: kind, location: point, modifierFlags: [],
                        timestamp: monotonicNow(), windowNumber: window.windowNumber, context: nil,
                        eventNumber: click, clickCount: click, pressure: 1) else { throw ControlFailure("input_failed") }
                    markStarted()
                    window.sendEvent(event)
                }
            }
        } else {
            let keys = method == "type_text" ? try string(args["text"], allowEmpty: true).map { (String($0), UInt16(0), NSEvent.ModifierFlags()) }
                : [try key(args["keys"])]
            for (characters, code, flags) in keys {
                try validate()
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: type == .keyDown ? flags : [],
                        timestamp: monotonicNow(), windowNumber: window.windowNumber, context: nil,
                        characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else {
                        throw ControlFailure("input_failed")
                    }
                    markStarted()
                    window.sendEvent(event)
                }
            }
        }
        try validate()
        return ["status": "dispatched", "effectVerified": false, "inputRouting": "background", "inputBackend": "native-owned-webkit"]
    }

    private static func key(_ raw: Any?) throws -> (String, UInt16, NSEvent.ModifierFlags) {
        guard let names = raw as? [String] else { throw ControlFailure("invalid_request") }
        let modifiers: [String: NSEvent.ModifierFlags] = ["CMD": .command, "COMMAND": .command,
            "CTRL": .control, "CONTROL": .control, "ALT": .option, "OPTION": .option, "SHIFT": .shift]
        let codes: [String: (String, UInt16)] = ["ENTER": ("\r", 36), "RETURN": ("\r", 36), "TAB": ("\t", 48),
            "SPACE": (" ", 49), "BACKSPACE": ("\u{7f}", 51), "ESC": ("\u{1b}", 53), "ESCAPE": ("\u{1b}", 53),
            "DELETE": ("\u{f728}", 117), "HOME": ("\u{f729}", 115), "END": ("\u{f72b}", 119),
            "PAGEUP": ("\u{f72c}", 116), "PAGEDOWN": ("\u{f72d}", 121),
            "LEFT": ("\u{f702}", 123), "RIGHT": ("\u{f703}", 124), "DOWN": ("\u{f701}", 125), "UP": ("\u{f700}", 126),
            "A": ("a", 0), "C": ("c", 8), "V": ("v", 9), "X": ("x", 7), "Z": ("z", 6)]
        var flags: NSEvent.ModifierFlags = []
        var value: (String, UInt16)?
        for name in names.map({ $0.uppercased() }) {
            if let flag = modifiers[name] { flags.insert(flag) }
            else if let found = codes[name], value == nil { value = found }
            else { throw ControlFailure("unsupported_action", "Unsupported owned-window key combination.") }
        }
        guard let value else { throw ControlFailure("invalid_request") }
        return (value.0, value.1, flags)
    }
}
