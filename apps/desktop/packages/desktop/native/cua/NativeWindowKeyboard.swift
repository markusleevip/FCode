import AppKit
import ApplicationServices
import Carbon

@MainActor enum NativeWindowKeyboard {
    static func prepare(_ method: String, _ args: JSONObject, state: WindowObservation, target: JSONObject,
                        observations: ObservationStore, input: InputControl, epoch: Int,
                        app: NSRunningApplication, windowId: Int) throws -> BackgroundInput.Operation {
        guard !IsSecureEventInputEnabled() else { throw ControlFailure("not_authorized", "Secure keyboard input is active.") }
        let text = method == "type_text" ? try string(args["text"]) : ""
        let keys = method == "press_keys" ? try keySpec(args["keys"]) : (CGKeyCode(0), NSEvent.ModifierFlags(), "")
        let explicitElement: AXUIElement? = try args["elementIndex"].map {
            let element = state.elements[try integer($0, max: state.elements.count - 1)]
            try BackgroundInput.validate(element, target: target)
            try validateSecure(element)
            return element
        }
        if explicitElement == nil { _ = try focusedElement(app, target: target) }
        return BackgroundInput.Operation { markStarted in
            if let element = explicitElement {
                try input.check(epoch)
                _ = try observations.find(state.id, target: target)
                try BackgroundInput.validate(element, target: target)
                try validateSecure(element)
                markStarted()
                guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                    throw ControlFailure("input_failed", "The requested background keyboard control could not receive focus.")
                }
            }
            let receiver = try focusedElement(app, target: target)
            @MainActor func validate() throws {
                _ = try observations.find(state.id, target: target)
                try input.check(epoch)
                guard !IsSecureEventInputEnabled(), CFEqual(receiver, try focusedElement(app, target: target)) else {
                    throw ControlFailure("target_changed", "The target window keyboard receiver changed.")
                }
            }
            @MainActor func send(_ value: String, code: CGKeyCode, modifiers: NSEvent.ModifierFlags, unicode: Bool = false) throws {
                try validate()
                let down = try event(true, value, code: code, modifiers: modifiers, windowId: windowId, unicode: unicode)
                let up = try event(false, value, code: code, modifiers: modifiers, windowId: windowId, unicode: unicode)
                let heldId = "key:\(windowId):\(code)"
                try input.postWindow(down, to: app, epoch: epoch, heldId: heldId, release: up, markStarted: markStarted)
                // Tab and shortcuts may change their own receiver. Release only to the original window;
                // the next keyDown still validates the receiver before dispatching new input.
                _ = try observations.find(state.id, target: target)
                _ = try runningApp(target)
                try input.check(epoch)
                try input.postWindow(up, to: app, epoch: epoch, heldId: heldId, markStarted: markStarted)
            }
            if method == "press_keys", keys.0 == 0, keys.1 == .command,
               NativeWindowEditingSelection.isTextReceiver(receiver) {
                return try NativeWindowEditingSelection.selectAll(receiver, validate: validate, markStarted: markStarted)
            }
            if method == "press_keys" { try send(keys.2, code: keys.0, modifiers: keys.1) }
            else {
                let units = Array(text.utf16)
                var offset = 0
                while offset < units.count {
                    var end = min(offset + 20, units.count)
                    if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                    try send(String(decoding: units[offset..<end], as: UTF16.self), code: 0, modifiers: [], unicode: true)
                    offset = end
                    usleep(10000)
                }
            }
            return ["status": "dispatched", "effectVerified": false, "inputRouting": "background", "inputBackend": "native-window-events"]
        }
    }

    private static func focusedElement(_ app: NSRunningApplication, target: JSONObject) throws -> AXUIElement {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, 0.25)
        guard let raw = axValue(axApp, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw ControlFailure("unsupported_action", "Observe and focus a control in the target window before using the keyboard.")
        }
        let element = raw as! AXUIElement
        try BackgroundInput.validate(element, target: target)
        try validateSecure(element)
        return element
    }

    private static func validateSecure(_ element: AXUIElement) throws {
        let role = axValue(element, kAXRoleAttribute) as? String ?? ""
        let subrole = axValue(element, kAXSubroleAttribute) as? String ?? ""
        guard ![role, subrole].contains(kAXSecureTextFieldSubrole) else {
            throw ControlFailure("not_authorized", "Use the private credential flow for a secure text field.")
        }
    }

    private static func event(_ down: Bool, _ text: String, code: CGKeyCode,
                              modifiers: NSEvent.ModifierFlags, windowId: Int, unicode: Bool) throws -> CGEvent {
        guard let event = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero,
            modifierFlags: modifiers, timestamp: monotonicNow(), windowNumber: windowId, context: nil,
            characters: text, charactersIgnoringModifiers: text, isARepeat: false, keyCode: code)?.cgEvent else {
            throw ControlFailure("input_failed")
        }
        if unicode {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
        }
        return event
    }

    private static func keySpec(_ raw: Any?) throws -> (CGKeyCode, NSEvent.ModifierFlags, String) {
        guard let names = raw as? [String], !names.isEmpty, names.count <= 8 else { throw ControlFailure("invalid_request") }
        let modifiers: [String: NSEvent.ModifierFlags] = ["CMD": .command, "COMMAND": .command, "CTRL": .control,
            "CONTROL": .control, "ALT": .option, "OPTION": .option, "SHIFT": .shift]
        let codes: [String: CGKeyCode] = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
            "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18,
            "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
            "O": 31, "U": 32, "I": 34, "P": 35, "ENTER": 36, "RETURN": 36, "L": 37, "J": 38, "K": 40,
            "N": 45, "M": 46, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "ESC": 53, "ESCAPE": 53, "DELETE": 117,
            "HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126]
        var flags: NSEvent.ModifierFlags = []
        var keys: [CGKeyCode] = []
        var keyName = ""
        for name in names.map({ $0.uppercased() }) {
            if let flag = modifiers[name] { flags.insert(flag) }
            else if let code = codes[name] { keys.append(code); keyName = name }
            else { throw ControlFailure("unsupported_action", "Unsupported background key name.") }
        }
        guard keys.count == 1 else { throw ControlFailure("invalid_request", "One non-modifier key is required.") }
        let controlCharacters = ["ENTER": "\r", "RETURN": "\r", "TAB": "\t", "SPACE": " ",
            "BACKSPACE": "\u{8}", "DELETE": "\u{7f}", "ESC": "\u{1b}", "ESCAPE": "\u{1b}"]
        let functionKeys = ["LEFT": NSLeftArrowFunctionKey, "RIGHT": NSRightArrowFunctionKey,
            "UP": NSUpArrowFunctionKey, "DOWN": NSDownArrowFunctionKey, "HOME": NSHomeFunctionKey,
            "END": NSEndFunctionKey, "PAGEUP": NSPageUpFunctionKey, "PAGEDOWN": NSPageDownFunctionKey]
        let characters = controlCharacters[keyName] ?? functionKeys[keyName].flatMap(UnicodeScalar.init).map(String.init) ??
            (flags.contains(.shift) ? keyName : keyName.lowercased())
        return (keys[0], flags, characters)
    }
}
