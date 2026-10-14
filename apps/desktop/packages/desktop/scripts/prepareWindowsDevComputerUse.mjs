import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS_NATIVE_PROTOCOL } from "../../cua/windows-native-contract.js";

/** Bind development resources to the executable and freshly built Main entry. */
export function prepareWindowsDevComputerUse({ executable, appRoot }) {
  try {
    execFileSync(process.execPath, [join(appRoot, "scripts/build-windows-cua-helper.mjs"),
      "--development", "--host-executable", executable, "--host-app-root", appRoot], {
      cwd: appRoot, stdio: "inherit", windowsHide: true,
    });
    return true;
  } catch (error) {
    const output = join(appRoot, "dist-cua-helper", `windows-${process.arch}`);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "capability.json"), JSON.stringify({
      schemaVersion: 1, available: false, platform: "win32", arch: process.arch,
      nativeProtocolVersion: WINDOWS_NATIVE_PROTOCOL, reason: "development_build_failed",
    }));
    console.warn(`[dev] Windows Computer Use is unavailable: ${error.message}`);
    return false;
  }
}
