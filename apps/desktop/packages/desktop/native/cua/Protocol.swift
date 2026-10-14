import AppKit
import Foundation
import Security
import Darwin

typealias JSONObject = [String: Any]

struct ControlFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String? = nil) {
        self.code = code
        self.message = message ?? code
    }
}

func record(_ value: Any?, fields: Set<String>, required: Set<String>? = nil) throws -> JSONObject {
    guard let result = value as? JSONObject, Set(result.keys).isSubset(of: fields),
          (required ?? fields).isSubset(of: Set(result.keys)) else { throw ControlFailure("invalid_request") }
    return result
}

func string(_ value: Any?, limit: Int = 16384, allowEmpty: Bool = false) throws -> String {
    guard let result = value as? String, (allowEmpty || !result.isEmpty),
          result.utf8.count <= limit else { throw ControlFailure("invalid_request") }
    return result
}

func integer(_ value: Any?, min: Int = 0, max: Int = Int.max) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= Double(min), number.doubleValue <= Double(max) else {
        throw ControlFailure("invalid_request")
    }
    return number.intValue
}

func regionJSON(_ rect: CGRect) -> JSONObject {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

func monotonicNow() -> Double { ProcessInfo.processInfo.systemUptime }

final class ProtocolWriter {
    private let lock = NSLock()
    func send(id: String, result: JSONObject? = nil, error: Error? = nil) {
        var response: JSONObject = ["schemaVersion": 1, "id": id]
        if let result { response["result"] = result }
        if let error {
            let failure = error as? ControlFailure ?? ControlFailure("backend_failed", "Native operation failed.")
            response["error"] = ["code": failure.code, "message": failure.message]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
              data.count <= 32 * 1024 * 1024 else { return }
        lock.lock()
        defer { lock.unlock() }
        do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
        catch { exit(0) }
    }
}

func authenticateParent(diagnostic: Bool) throws {
    if diagnostic { return }
    try requireGUIParent()
    guard let resource = Bundle.main.url(forResource: "host-policy", withExtension: "json"),
          let data = try? Data(contentsOf: resource),
          let policy = try JSONSerialization.jsonObject(with: data) as? JSONObject else {
        throw ControlFailure("host_identity_invalid")
    }
    var guest: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: getppid())] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest else {
        throw ControlFailure("host_identity_invalid")
    }
    if let identifiers = policy["packagedHostBundleIdentifiers"] as? [String] {
        try authenticatePackagedHost(guest, identifiers: identifiers, archiveHash: policy["packagedHostAppAsarSHA256"])
        return
    }
    if let paths = policy["developmentExecutables"] as? [String], !paths.isEmpty {
        var info: CFDictionary?
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, [], &info) == errSecSuccess,
              let values = info as? JSONObject, let path = values[kSecCodeInfoMainExecutable as String] as? URL,
              paths.contains(path.resolvingSymlinksInPath().path) else {
            throw ControlFailure("host_identity_invalid")
        }
        return
    }
    let team = try string(policy["teamIdentifier"], limit: 64)
    guard team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil else {
        throw ControlFailure("host_identity_invalid")
    }
    let requirementText = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and (identifier \"dev.fcode.app\" or identifier \"dev.fcode.app.preview\")"
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          SecCodeCheckValidity(guest, [], requirement) == errSecSuccess else {
        throw ControlFailure("host_identity_invalid")
    }
}

func requireGUIParent() throws {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, getppid()]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 1024 * 1024 else {
        throw ControlFailure("host_identity_invalid")
    }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { throw ControlFailure("host_identity_invalid") }
    let argc = bytes.withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
    guard argc > 0 && argc < 4096 else { throw ControlFailure("host_identity_invalid") }
    var offset = 4
    while offset < size && bytes[offset] != 0 { offset += 1 }
    while offset < size && bytes[offset] == 0 { offset += 1 }
    var values: [String] = []
    while offset < size {
        let start = offset
        while offset < size && bytes[offset] != 0 { offset += 1 }
        if offset > start { values.append(String(decoding: bytes[start..<offset], as: UTF8.self)) }
        offset += 1
    }
    guard values.count >= argc, !values.prefix(argc).contains(where: { $0.hasPrefix("--type=") }),
          !values.dropFirst(argc).contains(where: { $0.hasPrefix("ELECTRON_RUN_AS_NODE=") }) else {
        throw ControlFailure("host_identity_invalid")
    }
}


func userSessionIsUnlocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? JSONObject,
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session[kCGSessionLoginDoneKey as String] as? Bool == true else { return false }
    // This WindowServer field is verified locally; compatibility on other OS versions remains a gate.
    return session["CGSSessionScreenIsLocked"] as? Bool != true
}

func requireUnlockedSession() throws {
    guard userSessionIsUnlocked() else {
        throw ControlFailure("desktop_locked", "Unlock the Mac and explicitly start a new Computer Use task.")
    }
}
