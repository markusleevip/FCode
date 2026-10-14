import ApplicationServices
import Foundation

let desktopEventTag: Int64 = 0x46434F4445435541

func isPhysicalDesktopEscape(_ type: CGEventType, _ event: CGEvent) -> Bool {
    type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 &&
        event.getIntegerValueField(.eventSourceUnixProcessID) == 0 &&
        event.getIntegerValueField(.eventSourceUserData) != desktopEventTag
}

/** The listener has its own run loop so a long input cannot delay user cancellation. */
final class DesktopTakeover: @unchecked Sendable {
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var tap: CFMachPort?
    private var interrupted = false
    private var generation = 0
    private let input: InputControl
    init(input: InputControl) { self.input = input }
    var isInterrupted: Bool { lock.lock(); defer { lock.unlock() }; return interrupted }

    func start() throws {
        stop()
        lock.lock(); interrupted = false; let expected = generation; lock.unlock()
        let ready = DispatchSemaphore(value: 0)
        Thread { [self] in
            let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                options: .listenOnly, eventsOfInterest: 1 << CGEventType.keyDown.rawValue,
                callback: { _, type, event, context in
                    guard let context else { return Unmanaged.passUnretained(event) }
                    let monitor = Unmanaged<DesktopTakeover>.fromOpaque(context).takeUnretainedValue()
                    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput || isPhysicalDesktopEscape(type, event) {
                        monitor.lock.lock(); monitor.interrupted = true; monitor.lock.unlock()
                        monitor.input.stop()
                    }
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            guard let created else { ready.signal(); return }
            let current = CFRunLoopGetCurrent()!
            let source = CFMachPortCreateRunLoopSource(nil, created, 0)!
            CFRunLoopAddSource(current, source, .commonModes)
            lock.lock()
            guard generation == expected else { lock.unlock(); CFMachPortInvalidate(created); ready.signal(); return }
            tap = created; loop = current; lock.unlock()
            ready.signal()
            CFRunLoopRun()
            CFMachPortInvalidate(created)
            CFRunLoopRemoveSource(current, source, .commonModes)
        }.start()
        guard ready.wait(timeout: .now() + 2) == .success else { stop(); throw ControlFailure("backend_timeout") }
        lock.lock(); let available = tap != nil; lock.unlock()
        guard available else { throw ControlFailure("permission_required", "Allow accessibility and event monitoring for the Computer Use Helper, then start a new task.") }
    }

    func stop() {
        lock.lock(); generation += 1; let current = loop; let existing = tap; loop = nil; tap = nil; lock.unlock()
        if let existing { CFMachPortInvalidate(existing) }
        if let current { CFRunLoopStop(current) }
    }
}
