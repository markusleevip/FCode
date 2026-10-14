import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS_NATIVE_EXECUTABLE, WINDOWS_NATIVE_PROTOCOL, parseWindowsJson } from "@fcode/cua/windows-native-contract";

const MANIFEST_BYTES = 64 * 1024;
const MAX_PE_OFFSET = 1024 * 1024;
const PE_MACHINE_X64 = 0x8664;
const MINIMUM_WINDOWS_BUILD = 22000;

/** Static discovery is inert. Hash/signature verification is mandatory before spawn. */
export function resolveWindowsComputerUseHelperResource(options: {
  root: string; packaged: boolean; platform: string; arch: string;
}): string | undefined {
  if (options.platform !== "win32" || options.arch !== "x64") return undefined;
  let manifestFd: number | undefined;
  let executableFd: number | undefined;
  try {
    const resourceRoot = join(options.root, `windows-${options.arch}`);
    manifestFd = openSync(join(resourceRoot, "capability.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(manifestFd);
    if (!info.isFile() || info.size < 1 || info.size > MANIFEST_BYTES) return undefined;
    const bytes = Buffer.alloc(MANIFEST_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(manifestFd, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    const value = parseWindowsJson(bytes.subarray(0, count).toString("utf8"), MANIFEST_BYTES);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const manifest = value as Record<string, unknown>;
    const admitted = manifest.available === true || (!options.packaged && manifest.available === false &&
      manifest.developmentAvailable === true && manifest.reason === "development_limited" &&
      manifest.hostRole === "electron-main" && manifest.signing === "development-hash" && !manifest.leaseTestScope);
    if (manifest.schemaVersion !== 1 || !admitted || manifest.platform !== "win32" ||
        manifest.arch !== options.arch || manifest.nativeProtocolVersion !== WINDOWS_NATIVE_PROTOCOL ||
        manifest.executableName !== WINDOWS_NATIVE_EXECUTABLE || manifest.minimumOsBuild !== MINIMUM_WINDOWS_BUILD ||
        !Array.isArray(manifest.capabilities) || !manifest.capabilities.includes("win32-window-messages") ||
        !manifest.capabilities.includes("uia-observation") || !manifest.capabilities.includes("application-window-ui") ||
        !manifest.capabilities.includes("desktop-lease-journal") ||
        (options.packaged && manifest.signing !== "authenticode")) return undefined;
    const executable = join(resourceRoot, WINDOWS_NATIVE_EXECUTABLE);
    if (!statSync(executable).isFile()) return undefined;
    executableFd = openSync(executable, constants.O_RDONLY | constants.O_NONBLOCK);
    const file = fstatSync(executableFd);
    if (!file.isFile() || file.size < 64) return undefined;
    const dos = Buffer.alloc(64);
    if (readSync(executableFd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) return undefined;
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < dos.length || peOffset > MAX_PE_OFFSET || peOffset + 6 > file.size) return undefined;
    const header = Buffer.alloc(6);
    if (readSync(executableFd, header, 0, header.length, peOffset) !== header.length ||
        header.readUInt32LE(0) !== 0x00004550 || header.readUInt16LE(4) !== PE_MACHINE_X64) return undefined;
    return executable;
  } catch { return undefined; }
  finally {
    if (manifestFd !== undefined) closeSync(manifestFd);
    if (executableFd !== undefined) closeSync(executableFd);
  }
}
