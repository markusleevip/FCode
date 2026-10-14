import AppKit
import ApplicationServices
import Foundation
import Darwin
import Carbon

let diagnostic = CommandLine.arguments == [CommandLine.arguments[0], "--diagnostic"]
let writer = ProtocolWriter()
do { try authenticateParent(diagnostic: diagnostic) }
catch { writer.send(id: "startup", error: error); exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let input = InputControl()
let engine = MainActor.assumeIsolated { NativeEngine(input: input) }
let work = DispatchQueue(label: "dev.fcode.cua.actions")
let pendingLock = NSLock()
var pending = 0

func status() -> JSONObject {
    ["available": !diagnostic, "platform": "darwin", "protocolVersion": 4,
     "minimumMacOS": "14.0",
     "desktopObservation": !diagnostic, "desktopInput": !diagnostic, "physicalEscapeTakeover": !diagnostic,
     "desktopInterrupted": engine.desktop.takeover.isInterrupted, "grantOwner": Bundle.main.bundleIdentifier ?? "unknown",
     "pid": Int(getpid()),
     "managedBrowser": !diagnostic,
     "credentialInput": !diagnostic,
     "controlUi": !diagnostic,
     "normalBrowserUi": !diagnostic,
     "applicationLaunch": !diagnostic,
     "applicationWindowUi": !diagnostic,
     "axBatchObservation": !diagnostic,
     "nativeWindowInput": !diagnostic && NativeWindowInput.available,
     "nativeWindowSelectionAssist": !diagnostic,
     "nativeWindowInputCompatibility": "experimental-appkit-window-events",
     "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
     "screenLocked": !userSessionIsUnlocked(),
     "postEventAccess": CGPreflightPostEventAccess(), "secureEventInput": IsSecureEventInputEnabled(),
     "inputRoutings": diagnostic ? [] : ["background", "foreground"],
     "capabilities": diagnostic ? [] : ["window_capture", "ax_elements", "ax_actions", "managed_browser", "owned_mouse", "owned_keyboard"],
     "inputMethods": diagnostic ? [:] : ["backgroundExternal": ["element_action"] +
        (NativeWindowInput.available ? ["click", "move", "drag", "scroll", "type_text", "press_keys"] : []),
        "backgroundOwned": ["click", "move", "type_text", "press_keys", "request_credential", "type_credential"],
        "foregroundTestOnly": ["click", "move", "drag", "scroll", "type_text", "press_keys", "element_action", "activate_window"]]]
}

func accept(_ data: Data) {
    var id = "invalid"
    do {
        let request = try record(JSONSerialization.jsonObject(with: data), fields: ["schemaVersion", "id", "method", "params"])
        id = try string(request["id"], limit: 128)
        guard try integer(request["schemaVersion"]) == 1 else { throw ControlFailure("invalid_request") }
        let method = try string(request["method"], limit: 32)
        guard let params = request["params"] as? JSONObject else { throw ControlFailure("invalid_request") }
        if diagnostic && method != "status" { throw ControlFailure("not_authorized") }
        if method == "status" {
            _ = try record(params, fields: [])
            writer.send(id: id, result: status())
        } else if method == "lease" {
            _ = try record(params, fields: ["epoch", "ttlMs"])
            try input.lease(integer(params["epoch"], min: 1), ttlMs: integer(params["ttlMs"], min: 1, max: 10000))
            writer.send(id: id, result: ["status": "leased"])
        } else if method == "stop" {
            _ = try record(params, fields: ["epoch"])
            input.stop(epoch: try integer(params["epoch"]))
            DispatchQueue.main.async { engine.desktop.reset(); engine.observations.reset(); engine.browser.credentials.clear(); engine.chromeCredentials.store.clear() }
            writer.send(id: id, result: ["status": "stopped", "inputReleased": true])
        } else if method == "request_permissions" {
            _ = try record(params, fields: ["accessibility", "screenRecording"])
            guard let accessibility = params["accessibility"] as? Bool,
                  let screenRecording = params["screenRecording"] as? Bool else { throw ControlFailure("invalid_request") }
            let responseId = id
            try requireUnlockedSession()
            DispatchQueue.main.async {
                if !userSessionIsUnlocked() {
                    writer.send(id: responseId, error: ControlFailure("desktop_locked"))
                    return
                }
                if accessibility { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
                if screenRecording { _ = CGRequestScreenCaptureAccess() }
                writer.send(id: responseId, result: status())
            }
        } else {
            guard ["desktop_displays", "desktop_scope", "resolve_target", "execute", "installed_application", "open_application_ui", "preview_application_ui", "application_window_ui", "credential_ui_status", "focus_credential_ui", "preview_window_ui", "control_window_ui", "preview_chrome_ui", "chrome_window_ui", "chrome_credential_ui"].contains(method) else { throw ControlFailure("unsupported_action") }
            pendingLock.lock()
            guard pending < 16 else { pendingLock.unlock(); throw ControlFailure("control_busy") }
            pending += 1
            pendingLock.unlock()
            let responseId = id
            work.async {
                let complete = DispatchSemaphore(value: 0)
                Task { @MainActor in
                    do {
                        let result: JSONObject
                        if method == "desktop_displays" { result = try engine.desktop.displays(params) }
                        else if method == "desktop_scope" { result = try engine.desktop.authorize(params) }
                        else if method == "installed_application" {
                            _ = try record(params, fields: ["appId"])
                            try requireUnlockedSession()
                            result = try ApplicationLaunch.installed(string(params["appId"], limit: 256))
                        } else if method == "open_application_ui" {
                            _ = try record(params, fields: ["appId", "epoch"])
                            result = try await ApplicationLaunch.open(string(params["appId"], limit: 256),
                                epoch: integer(params["epoch"], min: 1), input: input)
                        } else if method == "chrome_credential_ui" {
                            result = try engine.chromeCredentials.execute(params, ui: engine.chromeUi, input: input)
                        } else if method == "preview_chrome_ui" || method == "preview_application_ui" {
                            _ = try record(params, fields: ["target"])
                            try requireUnlockedSession()
                            let ui: ApplicationWindowUi = method == "preview_chrome_ui" ? engine.chromeUi : engine.applicationUi
                            let target = try ui.target(record(params["target"], fields: ["appId", "pid", "windowId", "instanceId"], required: ["appId", "pid", "windowId"]))
                            let beforeContent = method == "preview_chrome_ui" ? chromeContentRegion(target) : nil
                            var preview = try await engine.observations.capture(target: target, includeElements: false, previewOnly: true)
                            if let content = beforeContent, content == chromeContentRegion(target),
                               var geometry = preview["previewFrameGeometry"] as? JSONObject {
                                geometry["contentRegion"] = regionJSON(content)
                                preview["previewFrameGeometry"] = geometry
                            }
                            result = preview
                        } else if method == "chrome_window_ui" || method == "application_window_ui" {
                            _ = try record(params, fields: ["target", "mode"])
                            let ui: ApplicationWindowUi = method == "chrome_window_ui" ? engine.chromeUi : engine.applicationUi
                            result = try ui.control(string(params["mode"]),
                                target: record(params["target"], fields: ["appId", "pid", "windowId", "instanceId"], required: ["appId", "pid", "windowId"]))
                        } else if method == "preview_window_ui" {
                            _ = try record(params, fields: [])
                            try requireUnlockedSession()
                            result = try await engine.observations.capture(target: engine.browser.previewTarget(),
                                includeElements: false, previewOnly: true)
                        } else if method == "control_window_ui" {
                            _ = try record(params, fields: ["mode"])
                            let mode = try string(params["mode"])
                            result = try engine.browser.controlUI(mode)
                            if mode != "show" { engine.observations.reset() }
                        } else if method == "credential_ui_status" {
                            _ = try record(params, fields: [])
                            try requireUnlockedSession()
                            result = engine.browser.credentials.metadata
                        } else if method == "focus_credential_ui" {
                            _ = try record(params, fields: ["epoch", "origin"])
                            let origin = try string(params["origin"])
                            guard engine.browser.metadata["origin"] as? String == origin,
                                  let window = engine.browser.window else { throw ControlFailure("not_authorized") }
                            try engine.browser.credentials.focus(origin: origin, windowId: window.windowNumber,
                                epoch: integer(params["epoch"], min: 1), input: input)
                            result = ["status": "focused"]
                        } else if method == "resolve_target" { try requireUnlockedSession(); result = ["target": try resolveTarget(params)] }
                        else { result = try await engine.execute(params) }
                        writer.send(id: responseId, result: result)
                    } catch { writer.send(id: responseId, error: error) }
                    complete.signal()
                }
                complete.wait()
                pendingLock.lock()
                pending -= 1
                pendingLock.unlock()
            }
        }
    } catch { writer.send(id: id, error: error) }
}

DispatchQueue(label: "dev.fcode.cua.control").async {
    var buffer = Data()
    do {
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw ControlFailure("transport_failed")
            }
            buffer.append(contentsOf: bytes.prefix(count))
            while let index = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<index])
                buffer.removeSubrange(...index)
                if line.count > 1024 * 1024 { throw ControlFailure("resource_limit") }
                if !line.isEmpty { accept(line) }
            }
            if buffer.count > 1024 * 1024 { throw ControlFailure("resource_limit") }
        }
    } catch { writer.send(id: "transport", error: error) }
    input.stop()
    exit(0)
}
app.run()
