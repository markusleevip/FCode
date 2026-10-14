#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME, DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_BUNDLE_ID } from "../../cua/broker-helper-constants.js";
import { getTargetPlatform } from "./target-platform.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = process.argv.includes("--required") || process.env.FCODE_CUA_RELEASE === "1";
const release = process.env.FCODE_CUA_RELEASE === "1";
const packagedHost = release || process.argv.includes("--packaged-host");
const target = getTargetPlatform();
const output = join(root, "dist-cua-helper");
mkdirSync(output, { recursive: true });

function unavailable(reason) {
  for (const appName of [DEV_HELPER_APP_NAME, HELPER_APP_NAME]) {
    rmSync(join(output, appName), { recursive: true, force: true });
  }
  writeFileSync(join(output, "capability.json"), JSON.stringify({ schemaVersion: 1, available: false, reason }));
  if (required) throw new Error(`[cua-helper] ${reason}`);
  console.warn(`[cua-helper] unavailable: ${reason}`);
}

if (process.platform !== "darwin" || target.os !== "darwin") {
  unavailable("macos_required");
} else {
  let compiler;
  try { compiler = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).trim(); }
  catch { unavailable("swift_toolchain_missing"); }
  if (compiler) {
    const identity = release ? process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME : "-";
    const teamIdentifier = process.env.FCODE_CUA_TEAM_IDENTIFIER;
    if (release && (!identity || !/^[A-Z0-9]+$/.test(teamIdentifier ?? ""))) {
      throw new Error("[cua-helper] Release requires a signing identity and FCODE_CUA_TEAM_IDENTIFIER.");
    }
    const appName = packagedHost ? HELPER_APP_NAME : DEV_HELPER_APP_NAME;
    const bundleId = packagedHost ? HELPER_BUNDLE_ID : DEV_CUA_HELPER_BUNDLE_ID;
    rmSync(join(output, packagedHost ? DEV_HELPER_APP_NAME : HELPER_APP_NAME), { recursive: true, force: true });
    const bundle = join(output, appName);
    const contents = join(bundle, "Contents");
    const bin = join(contents, "MacOS", "fcode-cua-helper");
    const resources = join(contents, "Resources");
    mkdirSync(dirname(bin), { recursive: true });
    mkdirSync(resources, { recursive: true });
    const targetArch = target.arch;
    const arch = targetArch === "arm64" ? "arm64" : targetArch === "x64" ? "x86_64" : undefined;
    if (!arch) throw new Error(`[cua-helper] Unsupported architecture: ${targetArch}`);
    const files = ["Protocol.swift", "PackagedHostIdentity.swift", "DesktopTakeover.swift", "DesktopCapture.swift", "DesktopEngine.swift", "InputControl.swift", "NativeWindowInput.swift", "NativeWindowKeyboard.swift", "NativeWindowEditingSelection.swift", "WindowIdentity.swift", "WindowCaptureGeometry.swift", "Observation.swift", "PreviewPointer.swift", "AXWindowCollection.swift", "BackgroundInput.swift", "ApplicationLaunch.swift",
      "Credentials.swift", "CredentialInput.swift", "ManagedBrowser.swift", "ManagedBrowserInput.swift", "NormalChromeWindowUi.swift", "NormalChromeCredentials.swift", "Engine.swift", "main.swift"]
      .map((name) => join(root, "native", "cua", name));
    const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync(compiler, ["-O", "-swift-version", "5", "-sdk", sdk, "-target", `${arch}-apple-macosx14.0`,
      ...files, "-o", bin], { stdio: "inherit" });
    writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${appName.replace(/\.app$/, "")}</string>
<key>CFBundleExecutable</key><string>fcode-cua-helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Capture selected windows or an explicitly confirmed desktop when you use Computer Use.</string>
</dict></plist>
`);
    const electron = resolve(root, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    const electronVersion = JSON.parse(readFileSync(resolve(root, "../../node_modules/electron/package.json"), "utf8")).version;
    const devElectron = resolve(root, "../../.fcode-runtime/desktop-dev", `${electronVersion}-${targetArch}`,
      "FCode Dev.app/Contents/MacOS/Electron");
    const policy = release ? { schemaVersion: 1, teamIdentifier } : packagedHost ? {
      schemaVersion: 1, packagedHostBundleIdentifiers: ["dev.fcode.app", "dev.fcode.app.preview"],
    } : {
      schemaVersion: 1, developmentExecutables: [electron, devElectron].map((path) => existsSync(path) ? realpathSync(path) : path),
    };
    writeFileSync(join(resources, "host-policy.json"), JSON.stringify(policy));
    execFileSync("codesign", ["--force", "--sign", identity,
      ...(release ? ["--options", "runtime", "--timestamp"] : []), bundle], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--strict", bundle], { stdio: "inherit" });
    writeFileSync(join(output, "capability.json"), JSON.stringify({ schemaVersion: 1, available: true,
      protocolVersion: 4, desktopObservation: true, desktopInput: true, physicalEscapeTakeover: true, managedBrowser: true, credentialInput: true, controlUi: true, normalBrowserUi: true, applicationLaunch: true, applicationWindowUi: true, axBatchObservation: true, inputRoutings: ["background", "foreground"], platform: "darwin", arch: targetArch, minimumMacOS: "14.0", appName,
      bundleId, signing: release ? "developer-id" : packagedHost ? "packaged-adhoc" : "development-adhoc" }));
    console.log(`[cua-helper] built ${targetArch} ${release ? "release" : packagedHost ? "packaged" : "development"} Helper`);
  }
}
