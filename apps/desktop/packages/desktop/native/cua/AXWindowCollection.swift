import AppKit
import ApplicationServices
import Foundation

struct WindowElements {
    let handles: [AXUIElement]
    let descriptions: [JSONObject]
    let truncationReason: String?
}

func collectWindowElements(_ target: JSONObject) throws -> WindowElements {
    let window = try uniqueAXWindow(target)
    var collector = AXElementCollector(deadline: monotonicNow() + 2)
    collector.visit(window, depth: 0)
    return WindowElements(handles: collector.handles, descriptions: collector.descriptions,
        truncationReason: collector.truncationReason)
}

private struct AXElementCollector {
    let deadline: Double
    var handles: [AXUIElement] = []
    var descriptions: [JSONObject] = []
    var truncationReason: String?

    mutating func visit(_ element: AXUIElement, depth: Int, parentIndex: Int? = nil) {
        guard handles.count < 300 else { truncate("element_limit"); return }
        guard depth < 30 else { truncate("depth_limit"); return }
        guard monotonicNow() < deadline else { truncate("time_limit"); return }
        AXUIElementSetMessagingTimeout(element, 0.1)
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success, let attributes = names as? [String] else {
            truncate("attribute_query"); return
        }
        let supported = Set(attributes)
        let keys = [kAXRoleAttribute, kAXSubroleAttribute, kAXEnabledAttribute,
            kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute]
            .filter { supported.contains($0) }
        var rawValues: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, keys as CFArray, [], &rawValues) == .success,
              let values = rawValues as? [Any], values.count == keys.count else {
            truncate("attribute_query"); return
        }
        var raw: JSONObject = [:]
        for (name, value) in zip(keys, values) {
            let ref = value as CFTypeRef
            if CFGetTypeID(ref) == AXValueGetTypeID(), AXValueGetType(ref as! AXValue) == .axError { continue }
            raw[name] = value
        }
        let role = raw[kAXRoleAttribute] as? String ?? "unknown"
        let subrole = raw[kAXSubroleAttribute] as? String ?? ""
        let index = handles.count
        var description: JSONObject = ["index": index, "role": role, "subrole": subrole,
            "enabled": raw[kAXEnabledAttribute] as? Bool ?? true]
        if let parentIndex { description["parentIndex"] = parentIndex }
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
            if let text = raw[name] as? String { description[name] = String(text.prefix(1000)) }
        }
        // Values are queried only after protection is known, never included in the batch.
        if subrole != kAXSecureTextFieldSubrole, role != kAXSecureTextFieldSubrole,
           supported.contains(kAXValueAttribute), let text = axValue(element, kAXValueAttribute) as? String {
            description["value"] = String(text.prefix(1000))
        }
        if subrole != kAXSecureTextFieldSubrole, role != kAXSecureTextFieldSubrole,
           supported.contains(kAXSelectedTextRangeAttribute), NativeWindowEditingSelection.isTextReceiver(element),
           let selection = NativeWindowEditingSelection.selection(element) {
            description["selection"] = ["start": selection.location, "length": selection.length]
            if let count = try? NativeWindowEditingSelection.characterCount(element) {
                description["characterCount"] = count
            }
        }
        if [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, kAXSecureTextFieldSubrole].contains(role),
           supported.contains(kAXFocusedAttribute), let focused = axValue(element, kAXFocusedAttribute) as? Bool {
            description["focused"] = focused
        }
        if let p = raw[kAXPositionAttribute], let s = raw[kAXSizeAttribute] {
            let position = p as CFTypeRef, size = s as CFTypeRef
            if CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
                var origin = CGPoint.zero, dimensions = CGSize.zero
                if AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) {
                    description["region"] = regionJSON(CGRect(origin: origin, size: dimensions))
                }
            }
        }
        var actions: CFArray?
        if AXUIElementCopyActionNames(element, &actions) == .success { description["actions"] = actions as? [String] ?? [] }
        handles.append(element)
        descriptions.append(description)
        guard supported.contains(kAXChildrenAttribute) else { return }
        var count = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success else {
            truncate("children_query"); return
        }
        guard count > 0 else { return }
        let limit = min(count, 300 - handles.count)
        guard limit > 0 else { truncate("element_limit"); return }
        if limit < count { truncate("element_limit") }
        var children: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, limit, &children) == .success,
              let nodes = children as? [AXUIElement] else { truncate("children_query"); return }
        for child in nodes { visit(child, depth: depth + 1, parentIndex: index) }
    }

    private mutating func truncate(_ reason: String) { if truncationReason == nil { truncationReason = reason } }
}
