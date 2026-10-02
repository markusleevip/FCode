const FCODE_PROCESS_PREFIX = "fcode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinFCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [FCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatFCodeMainProcessName(): string {
  return joinFCodeProcessName("main");
}

export function formatFCodeGpuProcessName(): string {
  return joinFCodeProcessName("gpu");
}

export function formatFCodeHostProcessName(label?: string): string {
  return joinFCodeProcessName("host", label);
}

export function formatFCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "FCode") {
    return joinFCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinFCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "FCode - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinFCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinFCodeProcessName("renderer", normalizedTitle);
}

export function formatFCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinFCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatFCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinFCodeProcessName(type, name);
}
