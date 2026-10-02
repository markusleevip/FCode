import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

function runIconEditor(editor, executable, icon) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(editor, [executable, "--set-icon", icon], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Windows icon editor exited with code ${code}`));
    });
  });
}

export async function prepareDevWindowsElectron({ electronBinary, iconPath, runtimeRoot }) {
  const electronPackage = require("electron/package.json");
  const editor = require.resolve("electron-winstaller/vendor/rcedit.exe");
  const icon = await readFile(iconPath);
  const source = await stat(electronBinary);
  const fingerprint = createHash("sha256")
    .update(electronPackage.version)
    .update(`${source.size}:${source.mtimeMs}`)
    .update(icon)
    .digest("hex");
  const destination = resolve(runtimeRoot, fingerprint, "electron.exe");
  const marker = resolve(runtimeRoot, fingerprint, "icon.sha256");

  try {
    const [currentMarker] = await Promise.all([readFile(marker, "utf8"), stat(destination)]);
    if (currentMarker === fingerprint) return destination;
  } catch {
    // 上次准备中断时没有有效标记，须重新复制完整运行时。
  }

  try {
    await cp(dirname(electronBinary), dirname(destination), { recursive: true, force: true });
    await runIconEditor(editor, destination, iconPath);
    await writeFile(marker, fingerprint);
  } catch (error) {
    throw new Error(`Cannot prepare branded Windows development executable: ${error.message}`, {
      cause: error,
    });
  }
  return destination;
}
