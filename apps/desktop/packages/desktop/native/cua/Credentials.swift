import AppKit
import Foundation

struct CredentialBinding: Equatable {
    let instance: String
    let windowId: Int
    let origin: String
    let role: String
    let subrole: String
    let title: String
    let description: String
    let region: CGRect
}

final class PrivateCredentialPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor final class CredentialStore: NSObject {
    private var id: String?
    private var binding: CredentialBinding?
    private var epoch = 0
    private var expiresAt = 0.0
    private var secret: String?
    private var panel: NSPanel?
    private var field: NSSecureTextField?
    private var timer: Timer?
    private var leasedInput: InputControl?

    var status: String { id == nil ? "none" : secret == nil ? "pending" : "ready" }

    var metadata: JSONObject {
        var value: JSONObject = ["status": status]
        if let binding { value["origin"] = binding.origin }
        return value
    }

    func focus(origin: String, windowId: Int, epoch: Int, input: InputControl) throws {
        try input.check(epoch)
        guard userSessionIsUnlocked(), status == "pending", self.epoch == epoch,
              monotonicNow() < expiresAt, binding?.origin == origin, binding?.windowId == windowId,
              let panel, let field else { throw ControlFailure("not_authorized", "The private credential request is no longer active.") }
        // Only the trusted root window's explicit user action reaches this method.
        NSApplication.shared.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    func request(_ value: CredentialBinding, epoch: Int, input: InputControl) throws -> JSONObject {
        guard id == nil else { throw ControlFailure("control_busy", "A credential request is already pending.") }
        try input.check(epoch)
        let identifier = UUID().uuidString
        id = identifier
        binding = value
        self.epoch = epoch
        leasedInput = input
        expiresAt = monotonicNow() + 120
        let win = PrivateCredentialPanel(contentRect: NSRect(x: 120, y: 160, width: 460, height: 190),
            styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        win.title = "FCode Private Credential Input"
        win.isReleasedWhenClosed = false
        win.hidesOnDeactivate = false
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 190))
        let label = NSTextField(wrappingLabelWithString: "Enter a password for \(value.origin). It stays in the private local control service and is used once for the selected password field.")
        label.frame = NSRect(x: 20, y: 120, width: 420, height: 52)
        let password = NSSecureTextField(frame: NSRect(x: 20, y: 75, width: 420, height: 28))
        password.placeholderString = "Password"
        password.setAccessibilityLabel("Private password")
        let submit = NSButton(title: "Use once", target: self, action: #selector(confirm))
        submit.frame = NSRect(x: 310, y: 20, width: 130, height: 32)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelRequest))
        cancel.frame = NSRect(x: 180, y: 20, width: 110, height: 32)
        [label, password, submit, cancel].forEach(view.addSubview)
        win.contentView = view
        panel = win
        field = password
        win.orderFrontRegardless()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if monotonicNow() >= self.expiresAt || !userSessionIsUnlocked() || (try? self.leasedInput?.check(epoch)) == nil {
                    self.clear()
                }
            }
        }
        return ["credentialId": identifier, "status": "pending", "expiresInMs": 120000, "origin": value.origin]
    }

    func take(_ identifier: String, binding value: CredentialBinding, epoch: Int) throws -> String {
        guard identifier == id, binding == value, epoch == self.epoch, monotonicNow() < expiresAt else {
            clear()
            throw ControlFailure("not_authorized", "The credential reference is expired or belongs to another target.")
        }
        guard let secret else { throw ControlFailure("credential_pending", "Complete the private credential input first.") }
        clear()
        return secret
    }

    @objc private func confirm() {
        guard id != nil, monotonicNow() < expiresAt, let field, !field.stringValue.isEmpty,
              field.stringValue.utf8.count <= 16384 else { return }
        secret = field.stringValue
        field.stringValue = ""
        panel?.close()
        panel = nil
        self.field = nil
    }

    @objc private func cancelRequest() { clear() }

    func clear() {
        field?.stringValue = ""
        field = nil
        panel?.close()
        panel = nil
        secret = nil
        binding = nil
        id = nil
        timer?.invalidate()
        timer = nil
        expiresAt = 0
        leasedInput = nil
    }
}
