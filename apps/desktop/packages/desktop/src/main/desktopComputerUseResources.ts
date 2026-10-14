import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { CuaControlError } from "@fcode/cua/control-contract";

const MANIFEST_LIMIT = 64 * 1024;

export function requireComputerUseHelperResource(options: Parameters<typeof resolveComputerUseHelperResource>[0]) {
  const executable = resolveComputerUseHelperResource(options);
  if (!executable) throw new CuaControlError("backend_unavailable", "A compatible Computer Use Helper is missing. Rebuild and restart FCode.",
    { stage: "native", reason: "helper_missing", retryable: false, requiresUserAction: true });
  return executable;
}

/** Static discoverability only; runtime identity, permissions and handshake remain mandatory. */
export function resolveComputerUseHelperResource(options: {
  root: string; packaged: boolean; platform: string; arch: string;
}): string | undefined {
  let fd: number | undefined;
  try {
    if (options.platform !== "darwin") return undefined;
    fd = openSync(join(options.root, "capability.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    const manifestStat = fstatSync(fd);
    if (!manifestStat.isFile() || manifestStat.size > MANIFEST_LIMIT) return undefined;
    const bytes = Buffer.alloc(MANIFEST_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MANIFEST_LIMIT) return undefined;
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const capability = value as Record<string, unknown>;
    const name = options.packaged ? "FCode Computer Use.app" : "FCode Computer Use Dev.app";
    if (capability.schemaVersion !== 1 || capability.available !== true || (capability.protocolVersion !== 3 && capability.protocolVersion !== 4) ||
        capability.platform !== options.platform || capability.arch !== options.arch || capability.appName !== name ||
        !Array.isArray(capability.inputRoutings) || !capability.inputRoutings.includes("background") ||
        ["axBatchObservation", "applicationWindowUi", "applicationLaunch", "normalBrowserUi", "credentialInput", "controlUi"]
          .some((key) => capability[key] !== true) ||
        (options.packaged && !["developer-id", "packaged-adhoc"].includes(String(capability.signing)))) return undefined;
    const executable = join(options.root, name, "Contents", "MacOS", "fcode-cua-helper");
    const executableStat = statSync(executable);
    if (!executableStat.isFile() || executableStat.size === 0) return undefined;
    accessSync(executable, constants.X_OK);
    return executable;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
