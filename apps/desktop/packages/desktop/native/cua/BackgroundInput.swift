import AppKit
import ApplicationServices
import Foundation

@MainActor enum BackgroundInput {
    private static let linkRole = "AXLink"
    struct Operation {
        let execute: @MainActor (_ markStarted: () -> Void) throws -> JSONObject
    }

    static func prepare(_ method: String, _ args: JSONObject, target: JSONObject,
                        observations: ObservationStore) throws -> Operation {
        guard method == "element_action" else {
            throw ControlFailure("unsupported_action",
                "Background input currently requires an observed AX element action; foreground takeover is disabled.")
        }
        let state = try observations.find(string(args["stateId"], limit: 128), target: target)
        let index = try integer(args["elementIndex"], max: state.elements.count - 1)
        var element = state.elements[index]
        let name = try string(args["action"])
        let value = name == "set_value" ? try string(args["value"], allowEmpty: true) : nil
        try validate(element, target: target)
        if name == "press" {
            element = try pressTarget(element, state: state, target: target)
        } else {
            let attribute = name == "focus" ? kAXFocusedAttribute : kAXValueAttribute
            var writable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, attribute as CFString, &writable) == .success,
                  writable.boolValue else {
                throw ControlFailure("unsupported_action", "The observed AX attribute cannot be changed in the background.")
            }
        }
        return Operation { markStarted in
            _ = try observations.find(state.id, target: target)
            try validate(element, target: target)
            try requireUnlockedSession()
            let error: AXError
            markStarted()
            if name == "press" { error = AXUIElementPerformAction(element, kAXPressAction as CFString) }
            else if name == "focus" {
                error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            } else {
                error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString,
                                                     value! as CFString)
            }
            // Visibility is not takeover. Main revokes the live epoch before an explicit handover.
            guard error == .success else {
                throw ControlFailure("input_failed", "The background AX action did not return a known success.")
            }
            let resolvedIndex = state.elements.firstIndex(where: { CFEqual($0, element) }) ?? index
            var result: JSONObject = ["status": "dispatched", "effectVerified": false, "inputRouting": "background",
                                      "axAction": name, "resolvedElementIndex": resolvedIndex]
            if let rect = axRegion(element), rect.width > 0, rect.height > 0,
               [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }),
               state.region.contains(rect), state.region == (try? windowRegion(target)),
               state.topology == topologyVersion() {
                result["operationPointerReceipt"] = ["target": pointerTarget(target), "region": regionJSON(state.region),
                    "topologyVersion": state.topology, "space": "screen", "x": rect.midX, "y": rect.midY,
                    "kind": "control-target", "phase": name == "press" ? "click" : "position",
                    "updatedAt": Date().timeIntervalSince1970 * 1000]
            }
            return result
        }
    }

    private static func pressTarget(_ source: AXUIElement, state: WindowObservation, target: JSONObject) throws -> AXUIElement {
        var current = source
        let sourceRole = axValue(source, kAXRoleAttribute) as? String
        let mayResolveParent = [kAXStaticTextRole, kAXImageRole].contains(sourceRole ?? "")
        for _ in 0..<15 {
            try validate(current, target: target)
            if axValue(current, kAXEnabledAttribute) as? Bool == false {
                throw ControlFailure("unsupported_action", "The observed control is disabled.")
            }
            let role = axValue(current, kAXRoleAttribute) as? String
            var actions: CFArray?
            let advertised = AXUIElementCopyActionNames(current, &actions) == .success &&
                (actions as? [String])?.contains(kAXPressAction) == true
            // Standard controls can implement the modern press API without advertising the legacy action.
            // The explicit AXPress request is still verified by the OS result and a fresh observation.
            if advertised || [kAXButtonRole, linkRole].contains(role ?? "") {
                guard CFEqual(current, source) || [kAXButtonRole, linkRole].contains(role ?? "") else {
                    throw ControlFailure("unsupported_action", "Invoke the containing non-button control explicitly.")
                }
                return current
            }
            if !mayResolveParent || [kAXButtonRole, linkRole].contains(role ?? "") { break }
            guard let currentIndex = state.elements.firstIndex(where: { CFEqual($0, current) }),
                  let parentIndex = state.descriptions[currentIndex]["parentIndex"] as? Int,
                  parentIndex >= 0, parentIndex < currentIndex,
                  let parent = axValue(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            let next = state.elements[parentIndex]
            guard CFEqual(parent, next) else {
                throw ControlFailure("observation_stale", "The observed label moved to another control.")
            }
            current = next
        }
        throw ControlFailure("unsupported_action", "Neither the observed label nor its nearest registered control supports AXPress.")
    }

    static func validate(_ element: AXUIElement, target: JSONObject) throws {
        let app = try runningApp(target)
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier else {
            throw ControlFailure("target_changed")
        }
        let expectedWindow = try uniqueAXWindow(target)
        var current: AXUIElement? = element
        for _ in 0..<30 {
            guard let value = current else { break }
            AXUIElementSetMessagingTimeout(value, 0.25)
            if axValue(value, kAXRoleAttribute) as? String == kAXWindowRole {
                guard CFEqual(value, expectedWindow) else { throw ControlFailure("target_changed") }
                return
            }
            if let window = axValue(value, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
                current = (window as! AXUIElement)
            } else if let parent = axValue(value, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() {
                current = (parent as! AXUIElement)
            } else { break }
        }
        throw ControlFailure("target_changed", "The AX element no longer belongs to the observed target window.")
    }
}
