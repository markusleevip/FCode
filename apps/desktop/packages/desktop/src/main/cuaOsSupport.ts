import { release } from "node:os";
import type { CuaOsSupport } from "@fcode/shared";

// ScreenCaptureKit window screenshots require the Helper deployment target macOS 14.
const CUA_MINIMUM_MACOS_VERSION = "14.0";
const CUA_MINIMUM_DARWIN_MAJOR = 23;

function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(major) || major < 1) return {
    kind: "macos-below-minimum", minimumMacOs: CUA_MINIMUM_MACOS_VERSION, currentMacOs: "unknown",
  };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
