import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "../packages/desktop/scripts/desktop-product-identity.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(workspaceRoot, "../..");
const desktopRoot = resolve(workspaceRoot, "packages/desktop");

export async function withReleaseLock(lockPath, action) {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    // 并发打包不仅会重写 out，还会互相恢复共享 NSIS 模板，导致未引用函数警告被当作错误。
    // 用目录的原子创建在准备和编译前取得唯一所有权，而不是仅隔离最终产物目录。
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Another release is active: ${lockPath}; after a forced termination, remove this lock only after confirming the previous release has stopped`,
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export function releaseArtifactNames({ os, arch, version, identity, environmentSuffix }) {
  const platform = os === "win" ? "win" : "mac";
  const base = `${identity.productName}-${version}-${platform}-${arch}${environmentSuffix}`;
  return os === "win" ? [`${base}.exe`] : [`${base}.dmg`, `${base}.zip`];
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Copies the built installers into the release folder and writes their SHA-256 files.
 * An existing release is never touched unless `overwrite` is set; then every replacement is first
 * copied and verified next to the old file, and only swapped in once all of them are ready.
 */
export async function stageReleaseArtifacts({ distRoot, releaseRoot, names, overwrite = false }) {
  const actual = (await readdir(distRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(exe|dmg|zip)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (actual.join("\n") !== [...names].sort().join("\n")) {
    throw new Error(
      `Unexpected release artifacts: expected ${names.join(", ")}; found ${actual.join(", ")}`,
    );
  }

  const sources = await Promise.all(
    names.map(async (name) => {
      const source = resolve(distRoot, name);
      const info = await stat(source);
      if (info.size === 0) throw new Error(`Empty release artifact: ${source}`);
      return { name, source, digest: await sha256(source) };
    }),
  );
  for (const { name } of sources) {
    if (
      !overwrite &&
      ((await exists(resolve(releaseRoot, name))) ||
        (await exists(resolve(releaseRoot, `${name}.sha256`))))
    ) {
      throw new Error(
        `Release already exists; refusing to overwrite: ${resolve(releaseRoot, name)}`,
      );
    }
  }

  await mkdir(releaseRoot, { recursive: true });
  if (overwrite) {
    const staged = [];
    try {
      for (const { name, source, digest } of sources) {
        const destination = resolve(releaseRoot, name);
        const suffix = `.partial-${randomUUID()}`;
        const entry = {
          name,
          digest,
          destination,
          partial: `${destination}${suffix}`,
          checksumPartial: `${destination}.sha256${suffix}`,
        };
        staged.push(entry);
        await copyFile(source, entry.partial, constants.COPYFILE_EXCL);
        if ((await sha256(entry.partial)) !== digest) {
          throw new Error(`SHA-256 mismatch: ${destination}`);
        }
        await writeFile(entry.checksumPartial, `${digest}  ${name}\n`, { flag: "wx" });
      }
      for (const { digest, destination, partial, checksumPartial } of staged) {
        await rename(partial, destination);
        await rename(checksumPartial, `${destination}.sha256`);
        console.log(`[release] ${destination} sha256=${digest} (overwritten)`);
      }
    } finally {
      // Whatever was not swapped in (a failure, or a file already renamed away) is cleaned up here.
      await Promise.all(
        staged.flatMap(({ partial, checksumPartial }) => [
          rm(partial, { force: true }),
          rm(checksumPartial, { force: true }),
        ]),
      );
    }
    return;
  }
  const created = [];
  try {
    for (const { name, source, digest } of sources) {
      const destination = resolve(releaseRoot, name);
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      created.push(destination);
      if ((await sha256(destination)) !== digest)
        throw new Error(`SHA-256 mismatch: ${destination}`);
      const checksum = `${digest}  ${name}\n`;
      const checksumPath = `${destination}.sha256`;
      await writeFile(checksumPath, checksum, { flag: "wx" });
      created.push(checksumPath);
      console.log(`[release] ${destination} sha256=${digest}`);
    }
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw error;
  }
}

function runBundle(args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(desktopRoot, "scripts/bundle.mjs"), ...args], {
      cwd: desktopRoot,
      env: environment,
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Desktop bundle failed with exit code ${code}`));
    });
  });
}

async function main(args) {
  const [osFlag, os, archFlag, arch, ...rest] = args;
  if (
    osFlag !== "--os" ||
    archFlag !== "--arch" ||
    !["win", "mac"].includes(os) ||
    !["x64", "arm64"].includes(arch) ||
    rest.some((arg) => arg !== "--skip-build" && arg !== "--overwrite")
  ) {
    throw new Error(
      "Usage: node scripts/stage-desktop-release.mjs --os win|mac --arch x64|arm64 [--skip-build] [--overwrite]",
    );
  }
  if (
    (os === "win" && process.platform !== "win32") ||
    (os === "mac" && process.platform !== "darwin")
  ) {
    throw new Error(`${os} packaging requires a ${os === "win" ? "Windows" : "macOS"} build host`);
  }
  if (os === "win" && arch !== "x64")
    throw new Error("Local Windows release currently supports x64 only");

  const metadata = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  const environment = { ...process.env, FCODE_ENV: process.env.FCODE_ENV || "production" };
  const identity = resolveDesktopProductIdentity(environment);
  const environmentSuffix = resolveDesktopArtifactSuffix(environment);
  const names = releaseArtifactNames({
    os,
    arch,
    version: metadata.version,
    identity,
    environmentSuffix,
  });
  const distDir = `dist-local-${os}-${arch}-${randomUUID()}`;
  const distRoot = resolve(desktopRoot, distDir);
  const releaseRoot = resolve(
    repositoryRoot,
    "releases",
    os === "win" ? "windows" : "macos",
    metadata.version,
  );
  const bundleArgs = [
    "--os",
    os,
    "--arch",
    arch,
    ...(rest.includes("--skip-build") ? ["--skip-build"] : []),
  ];

  console.log(
    `[release] ${identity.productName} ${metadata.version} ${os}/${arch} -> ${releaseRoot}`,
  );
  await withReleaseLock(resolve(workspaceRoot, ".tmp/desktop-release.lock"), async () => {
    await runBundle(bundleArgs, { ...environment, FCODE_DESKTOP_DIST_DIR: distDir });
    await stageReleaseArtifacts({
      distRoot,
      releaseRoot,
      names,
      overwrite: rest.includes("--overwrite"),
    });
    await rm(distRoot, { recursive: true, force: true });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  });
}
