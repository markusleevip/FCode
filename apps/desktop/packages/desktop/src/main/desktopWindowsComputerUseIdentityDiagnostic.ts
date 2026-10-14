import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "electron";
import { CuaWindowsNativeSession } from "@fcode/cua/windows-native-session/node";
import { CuaControlError } from "@fcode/cua/control-contract";
import { parseWindowsJson } from "@fcode/cua/windows-native-contract";

/** Explicit, development-only identity diagnostic. It grants no application access. */
export async function runWindowsComputerUseIdentityDiagnostic(resourceRoot: string): Promise<boolean> {
  const nonce = process.env.FCODE_WINDOWS_CUA_IDENTITY_PROBE;
  if (process.platform !== "win32" || app.isPackaged || !nonce) return false;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nonce) || process.type !== "browser") {
    throw new CuaControlError("identity_invalid");
  }
  const output = resolve(app.getAppPath(), "../..", ".tmp/windows-cua-identity");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  let native: CuaWindowsNativeSession | undefined;
  const report: Record<string, unknown> = { scope: "real-fcode-main-bootstrap-native-identity", modelDesktopAcceptance: false,
    applicationActionsDispatched: 0, parentPid: process.pid, status: "failed" };
  try {
    const resources = join(resourceRoot, "windows-x64");
    const manifest = parseWindowsJson(await readFile(join(resources, "capability.json"), "utf8"), 65536) as Record<string, unknown>;
    const executablePath = join(resources, "fcode-cua-helper.exe");
    if (manifest.hostRole !== "electron-main" || hash(await readFile(process.execPath)) !== manifest.parentImageSha256 ||
      hash(await readFile(executablePath)) !== manifest.helperSha256) throw new CuaControlError("identity_invalid");
    native = await CuaWindowsNativeSession.start({ executablePath,
      verifyHelper: async () => ({ parentImageSha256: String(manifest.parentImageSha256) }),
    });
    const status = await native.status();
    if (status.hostRole !== "electron-main") throw new CuaControlError("identity_invalid");
    report.status = "passed"; report.hostRole = status.hostRole; report.helperPid = status.helperPid;
  } catch (error) {
    report.error = error instanceof CuaControlError ? error.code : "diagnostic_failed";
    if (error instanceof Error && ["Error", "TypeError", "RangeError", "CuaControlError"].includes(error.name)) report.errorType = error.name;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (["ENOENT", "EACCES", "EPERM", "EPIPE", "ECONNRESET", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"].includes(String(code))) report.systemCode = code;
  }
  finally { await native?.close(); }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${nonce}.json`), JSON.stringify(report, null, 2));
  app.exit(report.status === "passed" ? 0 : 1);
  return true;
}
