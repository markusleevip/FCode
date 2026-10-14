#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { getTargetPlatform } from "./target-platform.mjs";
import { WINDOWS_NATIVE_EXECUTABLE, WINDOWS_NATIVE_PROTOCOL } from "../../cua/windows-native-contract.js";

const desktopRoot = resolve(import.meta.dirname, "..");
const target = getTargetPlatform();
const required = process.argv.includes("--required") || process.env.FCODE_CUA_RELEASE === "1";
const development = process.argv.includes("--development");
const output = join(desktopRoot, "dist-cua-helper", `windows-${target.arch}`);
const manifestPath = join(output, "capability.json");
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function unavailable(reason) {
  mkdirSync(output, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, available: false, platform: "win32", arch: target.arch,
    nativeProtocolVersion: WINDOWS_NATIVE_PROTOCOL, reason }));
  if (required || development) throw new Error(`[windows-cua-helper] ${reason}`);
  console.warn(`[windows-cua-helper] unavailable: ${reason}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`[windows-cua-helper] ${name} requires a path`);
  return resolve(value);
}

function build() {
  if (process.platform !== "win32" || target.os !== "win32") return unavailable("windows_build_host_required");
  if (target.arch !== "x64") return unavailable("architecture_unverified");
  const programFiles = process.env["ProgramFiles(x86)"] ?? process.env.ProgramFiles;
  if (!programFiles) return unavailable("visual_studio_discovery_unavailable");
  const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return unavailable("msvc_toolchain_missing");
  const installation = execFileSync(vswhere, ["-latest", "-version", "[17.0,18.0)", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], {
    encoding: "utf8", windowsHide: true,
  }).trim();
  if (!installation) return unavailable("msvc_toolchain_missing");
  const cmake = join(installation, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
  if (!existsSync(cmake)) return unavailable("cmake_toolchain_missing");
  const require = createRequire(import.meta.url);
  const hostExecutable = argument("--host-executable") ?? join(dirname(require.resolve("electron/package.json")), "dist", "electron.exe");
  if (!existsSync(hostExecutable)) return unavailable("host_executable_missing");
  const parentImageSha256 = hashFile(hostExecutable);
  const hostAppRoot = argument("--host-app-root");
  const hostRole = hostAppRoot ? "electron-main" : "prototype-image";
  const leaseScopeIndex = process.argv.indexOf("--test-lease-scope");
  const leaseTestScope = leaseScopeIndex === -1 ? "" : process.argv[leaseScopeIndex + 1];
  if (leaseScopeIndex !== -1 && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(leaseTestScope ?? "") || hostAppRoot || required)) {
    throw new Error("[windows-cua-helper] Lease fault scopes require a UUID and non-release Node prototype");
  }
  let hostEntrySha256 = "", hostPackageSha256 = "";
  if (hostAppRoot) {
    if (hostAppRoot.toLowerCase() !== desktopRoot.toLowerCase()) throw new Error("[windows-cua-helper] Development Main must belong to this desktop workspace");
    const hostPackage = JSON.parse(readFileSync(join(hostAppRoot, "package.json"), "utf8"));
    if (hostPackage.name !== "@fcode/desktop" || hostPackage.main !== "out/main/index.js") throw new Error("[windows-cua-helper] Unexpected desktop application entry");
    hostEntrySha256 = hashFile(join(hostAppRoot, "out/main/index.js"));
    hostPackageSha256 = hashFile(join(hostAppRoot, "package.json"));
  }
  const identityFault = process.argv.includes("--test-entry-mismatch");
  if (development && (!hostAppRoot || required || identityFault || leaseTestScope)) {
    throw new Error("[windows-cua-helper] Development routes require the real non-release GUI Main without fault policies");
  }
  if (identityFault) {
    if (!hostAppRoot || required) throw new Error("[windows-cua-helper] Identity fault fixtures require a non-release development Main");
    hostEntrySha256 = "00".repeat(32);
  }
  const buildRoot = join(desktopRoot, "..", "..", ".tmp", "windows-cua", target.arch);
  mkdirSync(buildRoot, { recursive: true });
  const compilerEnvironment = { ...process.env, VSLANG: "1033", DOTNET_CLI_UI_LANGUAGE: "en-US" };
  execFileSync(cmake, ["-S", join(desktopRoot, "native", "cua-windows"), "-B", buildRoot, "-G", "Visual Studio 17 2022",
    "-A", "x64", `-DFCODE_HOST_IMAGE_SHA256=${parentImageSha256}`, `-DFCODE_HOST_ROLE=${hostRole}`,
    `-DFCODE_HOST_APP_ROOT_LITERAL=${JSON.stringify(hostAppRoot ?? "")}`, `-DFCODE_HOST_PACKAGE_SHA256=${hostPackageSha256}`,
    `-DFCODE_HOST_ENTRY_SHA256=${hostEntrySha256}`, `-DFCODE_LEASE_TEST_SCOPE=${leaseTestScope}`], { stdio: "inherit", windowsHide: true, env: compilerEnvironment });
  execFileSync(cmake, ["--build", buildRoot, "--config", "Release", "--parallel", "2"], { stdio: "inherit", windowsHide: true, env: compilerEnvironment });
  const executable = join(buildRoot, "Release", WINDOWS_NATIVE_EXECUTABLE);
  if (!existsSync(executable)) throw new Error("[windows-cua-helper] Compiler did not produce a helper");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, WINDOWS_NATIVE_EXECUTABLE), readFileSync(executable));
  // Compiling the protocol prototype does not prove capture/input or production signing.
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, available: false, platform: "win32", arch: target.arch,
    nativeProtocolVersion: WINDOWS_NATIVE_PROTOCOL, executableName: WINDOWS_NATIVE_EXECUTABLE,
    minimumOsBuild: 22000, signing: "development-hash", capabilities: development ?
      ["uia-observation", "win32-window-messages", "application-window-ui", "desktop-lease-journal", "desktop-monitor-capture", "win32-send-input"] : [],
    ...(development ? { developmentAvailable: true } : {}),
    reason: development ? "development_limited" : identityFault ? "identity_fault_fixture" : "native_routes_unverified",
    helperSha256: hashFile(executable), parentImageSha256, hostRole, hostEntrySha256, hostPackageSha256,
    ...(leaseTestScope ? { leaseTestScope } : {}) }));
  console.log(development ? "[windows-cua-helper] Limited GUI Main development routes compiled; packaged support remains unavailable" :
    "[windows-cua-helper] Native protocol prototype compiled; product routes remain unavailable");
  if (required) throw new Error("[windows-cua-helper] Production routes and signing have not passed acceptance");
}

build();
