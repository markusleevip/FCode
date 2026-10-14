import Foundation
import Security
import CryptoKit

// Local packages bind the helper to their enclosing signed GUI executable, never to a path in the source tree.
func authenticatePackagedHost(_ guest: SecCode, identifiers: [String], archiveHash: Any?) throws {
    let allowed = Set(["dev.fcode.app", "dev.fcode.app.preview"])
    guard !identifiers.isEmpty, Set(identifiers).isSubset(of: allowed),
          Bundle.main.bundleIdentifier == "dev.fcode.cua-helper",
          Bundle.main.bundleURL.lastPathComponent == "FCode Computer Use.app" else {
        throw ControlFailure("host_identity_invalid")
    }
    let helper = Bundle.main.bundleURL.resolvingSymlinksInPath()
    let resources = helper.deletingLastPathComponent()
    let hostResources = resources.deletingLastPathComponent()
    let hostContents = hostResources.deletingLastPathComponent()
    let hostURL = hostContents.deletingLastPathComponent()
    guard resources.lastPathComponent == "cua-helper", hostResources.lastPathComponent == "Resources",
          hostContents.lastPathComponent == "Contents", hostURL.pathExtension == "app",
          let host = Bundle(url: hostURL), let identifier = host.bundleIdentifier,
          identifiers.contains(identifier), let executable = host.executableURL else {
        throw ControlFailure("host_identity_invalid")
    }
    try verifyPackagedHostArchive(hostResources.appendingPathComponent("app.asar"), expected: archiveHash)
    var staticGuest: SecStaticCode?
    var info: CFDictionary?
    var staticHost: SecStaticCode?
    var staticHelper: SecStaticCode?
    guard SecCodeCopyStaticCode(guest, [], &staticGuest) == errSecSuccess, let staticGuest,
          SecCodeCopySigningInformation(staticGuest, [], &info) == errSecSuccess,
          let values = info as? JSONObject,
          values[kSecCodeInfoIdentifier as String] as? String == identifier,
          let parentExecutable = values[kSecCodeInfoMainExecutable as String] as? URL,
          parentExecutable.resolvingSymlinksInPath() == executable.resolvingSymlinksInPath(),
          SecCodeCheckValidity(guest, [], nil) == errSecSuccess,
          SecStaticCodeCreateWithPath(hostURL as CFURL, [], &staticHost) == errSecSuccess, let staticHost,
          SecStaticCodeCheckValidity(staticHost, [], nil) == errSecSuccess,
          SecStaticCodeCreateWithPath(helper as CFURL, [], &staticHelper) == errSecSuccess, let staticHelper,
          SecStaticCodeCheckValidity(staticHelper, [], nil) == errSecSuccess else {
        throw ControlFailure("host_identity_invalid")
    }
}

private func verifyPackagedHostArchive(_ url: URL, expected: Any?) throws {
    guard let expected = expected as? String, expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
          values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size > 0, size <= 512 * 1024 * 1024,
          let file = try? FileHandle(forReadingFrom: url) else { throw ControlFailure("host_identity_invalid") }
    defer { try? file.close() }
    var hash = SHA256()
    var count = 0
    while true {
        let bytes: Data
        do { bytes = try file.read(upToCount: 1024 * 1024) ?? Data() }
        catch { throw ControlFailure("host_identity_invalid") }
        if bytes.isEmpty { break }
        count += bytes.count
        guard count <= size else { throw ControlFailure("host_identity_invalid") }
        hash.update(data: bytes)
    }
    guard count == size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected else {
        throw ControlFailure("host_identity_invalid")
    }
}
