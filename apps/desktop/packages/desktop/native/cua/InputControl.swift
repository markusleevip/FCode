import AppKit
import ApplicationServices
import Foundation
import Darwin

final class InputControl {
    private let lock = NSRecursiveLock()
    private let eventSource = CGEventSource(stateID: .privateState)
    private var currentEpoch = 0
    private var revokedEpoch = 0
    private var deadline = 0.0
    private var heldKeys = Set<CGKeyCode>()
    private var heldButtons = Set<CGMouseButton>()
    private var heldWindowInputs: [String: (NSRunningApplication, CGEvent)] = [:]
    private var activeInputs = 0
    private var dispatches = 0
    var dispatchedCount: Int { lock.lock(); defer { lock.unlock() }; return dispatches }
    private var lockFD: Int32 = -1
    private let watchdog: DispatchSourceTimer

    init() {
        watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.fcode.cua.watchdog"))
        watchdog.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        watchdog.setEventHandler { [weak self] in self?.expire() }
        watchdog.resume()
    }

    func lease(_ epoch: Int, ttlMs: Int) throws {
        lock.lock()
        defer { lock.unlock() }
        guard epoch > revokedEpoch, epoch >= currentEpoch, ttlMs > 0, ttlMs <= 10000 else {
            throw ControlFailure("permission_stale")
        }
        if epoch != currentEpoch && activeInputs > 0 { throw ControlFailure("execution_uncertain") }
        if !userSessionIsUnlocked() { stop(); try requireUnlockedSession() }
        if !AXIsProcessTrusted() || !CGPreflightScreenCaptureAccess() {
            stop(epoch: epoch)
            throw ControlFailure("permission_required", "Accessibility and screen recording permissions are required.")
        }
        try acquireDesktopLock()
        if epoch != currentEpoch { releaseLocked() }
        currentEpoch = epoch
        deadline = monotonicNow() + Double(ttlMs) / 1000
    }

    func stop(epoch: Int? = nil) {
        lock.lock()
        defer { lock.unlock() }
        revokedEpoch = max(revokedEpoch, max(currentEpoch, epoch ?? currentEpoch))
        deadline = 0
        releaseLocked()
        releaseDesktopLockIfStopped()
    }

    func begin(_ epoch: Int) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        activeInputs += 1
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        activeInputs -= 1
        releaseDesktopLockIfStopped()
    }

    func check(_ epoch: Int) throws {
        if !userSessionIsUnlocked() { stop(); try requireUnlockedSession() }
        lock.lock()
        defer { lock.unlock() }
        guard epoch == currentEpoch, epoch > revokedEpoch, deadline > monotonicNow(),
              AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw ControlFailure("permission_stale") }
    }

    func post(_ event: CGEvent, epoch: Int, key: CGKeyCode? = nil, button: CGMouseButton? = nil, down: Bool = false) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        if let key { if down { heldKeys.insert(key) } else { heldKeys.remove(key) } }
        if let button { if down { heldButtons.insert(button) } else { heldButtons.remove(button) } }
        event.setIntegerValueField(.eventSourceUserData, value: desktopEventTag)
        dispatches += 1
        event.post(tap: .cghidEventTap)
    }

    func mouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton = .left,
               epoch: Int, count: Int = 1) throws {
        guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point,
                                  mouseButton: button) else { throw ControlFailure("input_failed") }
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        let isDown = [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type)
        let isUp = [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type)
        try post(event, epoch: epoch, button: isDown || isUp ? button : nil, down: isDown)
    }

    func postWindow(_ event: CGEvent, to app: NSRunningApplication, epoch: Int,
                    heldId: String? = nil, release: CGEvent? = nil, markStarted: () -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        guard !app.isTerminated, CGPreflightPostEventAccess() else { throw ControlFailure("permission_required") }
        if let heldId {
            if let release { heldWindowInputs[heldId] = (app, release) }
            else { heldWindowInputs.removeValue(forKey: heldId) }
        }
        markStarted()
        event.postToPid(app.processIdentifier)
    }


    func stopOnExpiredLease() { expire() }

    func text(_ value: String, epoch: Int, validate: () throws -> Void) throws {
        let units = Array(value.utf16)
        var offset = 0
        while offset < units.count {
            var end = min(offset + 20, units.count)
            if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
            let chunk = Array(units[offset..<end])
            try validate()
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else {
                    throw ControlFailure("input_failed")
                }
                event.flags = []
                chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                try post(event, epoch: epoch, key: 0, down: down)
            }
            usleep(10000)
            offset = end
        }
    }

    private static func keySpec(_ names: [String]) throws -> (CGKeyCode, CGEventFlags) {
        let modifiers: [String: CGEventFlags] = ["CMD": .maskCommand, "COMMAND": .maskCommand,
            "CTRL": .maskControl, "CONTROL": .maskControl, "ALT": .maskAlternate,
            "OPTION": .maskAlternate, "SHIFT": .maskShift]
        let codes: [String: CGKeyCode] = ["A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5,
            "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
            "Y": 16, "T": 17, "N": 45, "M": 46, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
            "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35,
            "ENTER": 36, "RETURN": 36, "L": 37, "J": 38, "K": 40, "TAB": 48,
            "SPACE": 49, "BACKSPACE": 51, "ESC": 53, "ESCAPE": 53, "DELETE": 117,
            "HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121,
            "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
            "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
            "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
            "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90]
        var flags: CGEventFlags = []
        var keys: [CGKeyCode] = []
        for name in names {
            let name = name.uppercased()
            if let flag = modifiers[name] { flags.insert(flag) }
            else if let code = codes[name] { keys.append(code) }
            else { throw ControlFailure("unsupported_action", "Unsupported key name.") }
        }
        guard keys.count == 1 else { throw ControlFailure("invalid_request", "One non-modifier key is required.") }
        return (keys[0], flags)
    }

    static func validateKeys(_ names: [String]) throws { _ = try keySpec(names) }

    func keys(_ names: [String], epoch: Int) throws {
        let (code, flags) = try Self.keySpec(names)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else {
                throw ControlFailure("input_failed")
            }
            event.flags = down ? flags : []
            try post(event, epoch: epoch, key: code, down: down)
        }
    }

    private func expire() {
        lock.lock()
        defer { lock.unlock() }
        if deadline > 0 && (deadline <= monotonicNow() || !userSessionIsUnlocked() ||
            !AXIsProcessTrusted() || !CGPreflightScreenCaptureAccess()) {
            revokedEpoch = max(revokedEpoch, currentEpoch)
            deadline = 0
            releaseLocked()
            releaseDesktopLockIfStopped()
        }
    }

    private func acquireDesktopLock() throws {
        if lockFD >= 0 { return }
        let directory = "/tmp/fcode-cua-control-\(getuid())"
        if mkdir(directory, 0o700) != 0 && errno != EEXIST { throw ControlFailure("control_busy") }
        var info = stat()
        guard lstat(directory, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o777 == 0o700 else {
            throw ControlFailure("control_busy")
        }
        let fd = open(directory + "/desktop.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ControlFailure("control_busy") }
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw ControlFailure("control_busy")
        }
        lockFD = fd
    }

    private func releaseDesktopLockIfStopped() {
        if lockFD >= 0 && activeInputs == 0 && deadline <= monotonicNow() {
            flock(lockFD, LOCK_UN)
            close(lockFD)
            lockFD = -1
        }
    }

    private func releaseLocked() {
        for (app, event) in heldWindowInputs.values where !app.isTerminated {
            event.postToPid(app.processIdentifier)
        }
        heldWindowInputs.removeAll()
        let location = CGEvent(source: nil)?.location ?? .zero
        for key in heldKeys {
            if let event = CGEvent(keyboardEventSource: eventSource, virtualKey: key, keyDown: false) {
                event.flags = []
                event.post(tap: .cghidEventTap)
            }
        }
        for button in heldButtons {
            let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
            if let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: location,
                    mouseButton: button) {
                event.flags = []
                event.post(tap: .cghidEventTap)
            }
        }
        heldKeys.removeAll()
        heldButtons.removeAll()
    }
}
