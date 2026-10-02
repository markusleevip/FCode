// Kimi model aliases adapted from CLIProxyAPI (MIT); client identity belongs to FCode.
import { arch } from "node:os";

const CODING_ALIASES = new Set([
  "kimi-k2.8",
  "k2.8",
  "kimi-k2.8-code",
  "k2.8-code",
  "kimi-k2.8-preview",
  "k2.8-preview",
  "kimi-k2.7-code",
  "k2.7-code",
  "kimi-for-coding",
  "for-coding",
]);
const HIGHSPEED_ALIASES = new Set([
  "kimi-k2.7-code-highspeed",
  "k2.7-code-highspeed",
  "kimi-for-coding-highspeed",
  "for-coding-highspeed",
]);
const CONTEXT_SUFFIX = "[1m]";

export function normalizeKimiModel(model: string): string {
  const match = /^(.*)\(([^()]*)\)$/.exec(model.trim());
  let base = (match ? match[1]! : model.trim()).trim().toLowerCase();
  if (base.endsWith(CONTEXT_SUFFIX)) base = base.slice(0, -CONTEXT_SUFFIX.length);
  const canonical = CODING_ALIASES.has(base)
    ? "kimi-for-coding"
    : HIGHSPEED_ALIASES.has(base)
      ? "kimi-for-coding-highspeed"
      : base.replace(/^kimi-/, "");
  return canonical + (match ? `(${match[2]})` : "");
}

export function applyKimiClientHeaders(headers: Headers): void {
  const version = headers.get("X-FCode-App-Version") ?? "unknown";
  if (!headers.has("User-Agent")) headers.set("User-Agent", `FCode/${version}`);
  headers.set("X-Msh-Platform", "FCode");
  headers.set("X-Msh-Version", version);
  headers.set("X-Msh-Device-Name", "FCode");
  headers.set("X-Msh-Device-Model", `${process.platform}/${arch()}`);
  // 设备 ID 已由 Host 账号持有；不读取其他 CLI 的设备文件或创建第二份凭据状态。
}
