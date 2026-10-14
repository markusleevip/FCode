import AppKit
import ApplicationServices

enum CredentialInput {
    static func binding(_ state: WindowObservation, index: Int, origin: String) throws -> CredentialBinding {
        guard index >= 0, index < state.elements.count, index < state.descriptions.count,
              let url = URL(string: origin), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil else { throw ControlFailure("not_authorized", "A verified HTTPS origin is required.") }
        let element = state.elements[index]
        let description = state.descriptions[index]
        AXUIElementSetMessagingTimeout(element, 0.25)
        let role = axValue(element, kAXRoleAttribute) as? String ?? ""
        let subrole = axValue(element, kAXSubroleAttribute) as? String ?? ""
        guard role == kAXSecureTextFieldSubrole || subrole == kAXSecureTextFieldSubrole,
              role == description["role"] as? String, subrole == description["subrole"] as? String else {
            throw ControlFailure("not_authorized", "The observed control is not a verified secure field (role=\(role), subrole=\(subrole)).")
        }
        guard axValue(element, kAXFocusedAttribute) as? Bool == true else {
            throw ControlFailure("not_authorized", "The verified secure field does not report AX focus.")
        }
        guard
              let rect = axRegion(element), let old = description["region"] as? JSONObject,
              (old["x"] as? NSNumber)?.doubleValue == Double(rect.minX),
              (old["y"] as? NSNumber)?.doubleValue == Double(rect.minY),
              (old["width"] as? NSNumber)?.doubleValue == Double(rect.width),
              (old["height"] as? NSNumber)?.doubleValue == Double(rect.height) else {
            throw ControlFailure("observation_stale", "The secure field geometry changed after observation.")
        }
        let title = axValue(element, kAXTitleAttribute) as? String ?? ""
        let name = axValue(element, kAXDescriptionAttribute) as? String ?? ""
        guard title == (description["AXTitle"] as? String ?? ""), name == (description["AXDescription"] as? String ?? "") else {
            throw ControlFailure("observation_stale")
        }
        let window = try uniqueAXWindow(state.target)
        var current: AXUIElement? = element
        var matched = false
        var documentVerified = false
        for _ in 0..<30 {
            guard let value = current else { break }
            if !documentVerified, axValue(value, kAXRoleAttribute) as? String == "AXWebArea" {
                let raw = axValue(value, kAXURLAttribute)
                let documentURL = (raw as? URL) ?? (raw as? String).flatMap(URL.init(string:))
                guard let documentURL, verifiedOrigin(documentURL) == origin else {
                    throw ControlFailure("not_authorized", "The secure field document must have the verified HTTPS origin.")
                }
                documentVerified = true
            }
            if CFEqual(value, window) { matched = true; break }
            guard let parent = axValue(value, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = (parent as! AXUIElement)
        }
        guard matched else { throw ControlFailure("observation_stale") }
        guard documentVerified else {
            throw ControlFailure("not_authorized", "The secure field document origin is unavailable.")
        }
        return CredentialBinding(instance: try string(state.target["instanceId"]),
            windowId: try integer(state.target["windowId"]), origin: origin,
            role: role, subrole: subrole, title: title, description: name, region: rect)
    }

    static func verifiedOrigin(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(),
              !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        let port = url.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
        return "https://\(host)\(port)"
    }
}
