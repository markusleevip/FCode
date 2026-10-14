import ApplicationServices
import Foundation

@MainActor enum NativeWindowEditingSelection {
    nonisolated static func isTextReceiver(_ element: AXUIElement) -> Bool {
        let role = axValue(element, kAXRoleAttribute) as? String ?? ""
        return [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role)
    }

    static func selectAll(_ element: AXUIElement, validate: () throws -> Void,
                          markStarted: () -> Void) throws -> JSONObject {
        try validate()
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success,
              settable.boolValue else {
            throw ControlFailure("unsupported_action", "The background text receiver does not expose a selectable range.")
        }
        let length = try characterCount(element)
        var range = CFRange(location: 0, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { throw ControlFailure("input_failed") }
        try validate()
        guard try characterCount(element) == length else {
            throw ControlFailure("target_changed", "The text changed before the selection action.")
        }
        markStarted()
        guard AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success,
              let selected = selection(element), selected.location == 0, selected.length == length else {
            throw ControlFailure("input_failed", "The background text selection could not be confirmed.")
        }
        try validate()
        return ["status": "dispatched", "effectVerified": false, "inputRouting": "background",
                "inputBackend": "ax-text-selection"]
    }

    nonisolated static func selection(_ element: AXUIElement) -> CFRange? {
        guard let raw = axValue(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = raw as! AXValue
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range),
              range.location >= 0, range.length >= 0, range.location <= 1_000_000,
              range.length <= 1_000_000 - range.location else { return nil }
        return range
    }

    nonisolated static func characterCount(_ element: AXUIElement) throws -> Int {
        guard let raw = axValue(element, kAXNumberOfCharactersAttribute), CFGetTypeID(raw) == CFNumberGetTypeID(),
              let count = raw as? NSNumber, count.intValue >= 0, count.intValue <= 1_000_000,
              count.doubleValue == Double(count.intValue) else {
            throw ControlFailure("unsupported_action", "The text receiver does not expose a bounded character count.")
        }
        return count.intValue
    }
}
