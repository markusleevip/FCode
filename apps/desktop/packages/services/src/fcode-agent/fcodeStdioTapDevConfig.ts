import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FCodeStdioTapDevState } from "@fcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface FCodeStdioTapStateFile {
  enabled?: boolean;
}

function isFCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getFCodeStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getFCodeStdioTapDevLogDir(): string {
  return join(getFCodeStdioTapDevDir(), "stdio-traffic");
}

function getFCodeStdioTapDevStatePath(): string {
  return join(getFCodeStdioTapDevDir(), "fcode-stdio-tap.json");
}

function readStateFile(path: string): FCodeStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FCodeStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readFCodeStdioTapDevState(): FCodeStdioTapDevState {
  const visible = isFCodeStdioTapDevVisible();
  const statePath = getFCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getFCodeStdioTapDevLogDir(),
    statePath,
  };
}

export function setFCodeStdioTapDevEnabled(enabled: boolean): FCodeStdioTapDevState {
  const visible = isFCodeStdioTapDevVisible();
  const statePath = getFCodeStdioTapDevStatePath();
  mkdirSync(getFCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readFCodeStdioTapDevState();
}
