import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REPAIR_TIMEOUT_MS = 180_000;
const REPAIR_HINT = "Check the download mirror/network, run pnpm rebuild electron, then retry ./run.sh.";

function executablePath(packageRoot, platform) {
  if (platform === "darwin") return resolve(packageRoot, "dist/Electron.app/Contents/MacOS/Electron");
  return resolve(packageRoot, "dist", platform === "win32" ? "electron.exe" : "electron");
}

async function isExecutable(file, platform) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runInstaller(installer, { env, timeoutMs }) {
  return new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, [installer], {
      cwd: dirname(installer), env, stdio: "inherit", timeout: timeoutMs,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveInstall();
      else reject(new Error(signal ? `Installer exited with signal ${signal}` : `Installer exited with code ${code}`));
    });
  });
}

/** Restore only the installed dependency's missing executable; never fall back to PATH. */
export async function ensureLocalElectronRuntime({
  packageJsonPath,
  platform = process.platform,
  env = process.env,
  timeoutMs = REPAIR_TIMEOUT_MS,
  log = console.log,
}) {
  const packageRoot = dirname(packageJsonPath);
  const executable = executablePath(packageRoot, platform);
  if (await isExecutable(executable, platform)) return executable;
  for (const flag of ["ELECTRON_SKIP_BINARY_DOWNLOAD", "ELECTRON_OVERRIDE_DIST_PATH"]) {
    if (env[flag]) throw new Error(`Local Electron executable is missing while ${flag} is set. Restore the runtime or unset that flag before retrying.`);
  }

  const installer = resolve(packageRoot, "install.js");
  try {
    await access(installer);
    log("[dev] Local Electron executable is missing. Restoring the installed package runtime...");
    await runInstaller(installer, { env, timeoutMs });
  } catch (error) {
    throw new Error(`Unable to restore local Electron runtime: ${error.message}. ${REPAIR_HINT}`, { cause: error });
  }
  if (!(await isExecutable(executable, platform))) {
    throw new Error(`Electron installer completed without a usable executable. ${REPAIR_HINT}`);
  }
  log("[dev] Local Electron runtime restored.");
  return executable;
}
