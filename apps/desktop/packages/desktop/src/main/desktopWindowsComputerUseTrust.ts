import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { CuaControlError } from "@fcode/cua/control-contract";
import { parseWindowsJson } from "@fcode/cua/windows-native-contract";

const executeFile = promisify(execFile);
const PIN = /^[0-9a-f]{64}$/;
async function hashFile(path: string) {
  const before = await stat(path);
  if (!before.isFile() || before.size === 0 || before.size > 512 * 1024 * 1024) throw new CuaControlError("identity_invalid");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new CuaControlError("identity_invalid");
  return hash.digest("hex");
}
async function signature(path: string) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new CuaControlError("identity_invalid");
  const encoded = Buffer.from(path, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
    "$s=Get-AuthenticodeSignature -LiteralPath $p; @{status=$s.Status.ToString(); thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress";
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
  const result = await executeFile(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  return parseWindowsJson(result.stdout, 65536) as { status?: unknown; thumbprint?: unknown };
}

/** Spawn-time checks complement native OS parent/pipe identity; availability is still independently gated. */
export async function verifyWindowsComputerUseHelper(options: {
  executablePath: string; hostExecutable: string; hostEntry: string; packaged: boolean; isMain: boolean;
}): Promise<{ parentImageSha256: string }> {
  try {
    if (process.platform !== "win32" || !options.isMain) throw new CuaControlError("identity_invalid");
    const manifestPath = join(dirname(options.executablePath), "capability.json");
    const info = await stat(manifestPath);
    if (!info.isFile() || info.size > 65536) throw new CuaControlError("identity_invalid");
    const manifest = parseWindowsJson(await readFile(manifestPath, "utf8"), 65536) as Record<string, unknown>;
    const admitted = manifest?.available === true || (!options.packaged && manifest?.available === false &&
      manifest.developmentAvailable === true && manifest.reason === "development_limited" && !manifest.leaseTestScope);
    if (!manifest || !admitted || manifest.hostRole !== "electron-main" ||
      !PIN.test(String(manifest.helperSha256)) || !PIN.test(String(manifest.parentImageSha256)) ||
      !PIN.test(String(manifest.hostEntrySha256))) throw new CuaControlError("identity_invalid");
    const image = await realpath(options.executablePath);
    const parent = await realpath(options.hostExecutable);
    const entry = await realpath(options.hostEntry);
    const [helperHash, parentHash, entryHash] = await Promise.all([hashFile(image), hashFile(parent), hashFile(entry)]);
    if (helperHash !== manifest.helperSha256 || parentHash !== manifest.parentImageSha256 || entryHash !== manifest.hostEntrySha256) {
      throw new CuaControlError("identity_invalid");
    }
    if (options.packaged) {
      if (manifest.signing !== "authenticode" || !/^[0-9a-f]{40}$/i.test(String(manifest.signerThumbprint))) throw new CuaControlError("identity_invalid");
      const [helperSignature, parentSignature] = await Promise.all([signature(image), signature(parent)]);
      if (helperSignature.status !== "Valid" || parentSignature.status !== "Valid" ||
        String(helperSignature.thumbprint).toLowerCase() !== String(manifest.signerThumbprint).toLowerCase() ||
        String(parentSignature.thumbprint).toLowerCase() !== String(manifest.signerThumbprint).toLowerCase()) {
        throw new CuaControlError("identity_invalid");
      }
    } else if (manifest.signing !== "development-hash") throw new CuaControlError("identity_invalid");
    // Recheck hashes after OS verification; native handshake checks the actual parent image again.
    if ((await hashFile(image)) !== helperHash || (await hashFile(entry)) !== entryHash) throw new CuaControlError("identity_invalid");
    return { parentImageSha256: parentHash };
  } catch { throw new CuaControlError("identity_invalid", "Windows Computer Use helper identity could not be verified."); }
}
