import AppKit
import Foundation

/** Private authenticated-parent pipe only. Main verifies the Chrome document and protected DOM focus. */
@MainActor final class NormalChromeCredentials {
    let store = CredentialStore()

    func execute(_ params: JSONObject, ui: NormalChromeWindowUi, input: InputControl) throws -> JSONObject {
        _ = try record(params, fields: ["mode", "target", "binding", "epoch", "credentialId"], required: ["mode"])
        try requireUnlockedSession()
        let mode = try string(params["mode"])
        if mode == "status" { return store.metadata }
        if mode == "clear" { store.clear(); return ["status": "cleared"] }
        let epoch = try integer(params["epoch"], min: 1)
        try input.check(epoch)
        let target = try ui.target(record(params["target"], fields: ["appId", "pid", "windowId", "instanceId"]))
        let raw = try record(params["binding"], fields: ["origin", "field", "name", "region"])
        let origin = try string(raw["origin"], limit: 2048)
        guard let url = URL(string: origin), CredentialInput.verifiedOrigin(url) == origin,
              url.path.isEmpty, url.query == nil, url.fragment == nil else { throw ControlFailure("not_authorized") }
        let region = try record(raw["region"], fields: ["x", "y", "width", "height"])
        guard let rect = CGRect(dictionaryRepresentation: ["X": region["x"]!, "Y": region["y"]!,
            "Width": region["width"]!, "Height": region["height"]!] as CFDictionary), rect.width > 0, rect.height > 0 else {
            throw ControlFailure("invalid_request")
        }
        let binding = CredentialBinding(instance: try string(target["instanceId"]),
            windowId: try integer(target["windowId"], min: 1), origin: origin,
            role: "ChromeProtectedInput", subrole: try string(raw["field"], limit: 512),
            title: raw["name"] as? String ?? "", description: "Private Chrome document binding", region: rect)
        if mode == "request" { return try store.request(binding, epoch: epoch, input: input) }
        if mode == "focus" {
            try store.focus(origin: origin, windowId: binding.windowId, epoch: epoch, input: input)
            return ["status": "focused"]
        }
        if mode == "take" {
            // This response remains on the parent-only Native pipe; never forward it to a model.
            return ["secret": try store.take(string(params["credentialId"], limit: 128), binding: binding, epoch: epoch)]
        }
        throw ControlFailure("unsupported_action")
    }
}
