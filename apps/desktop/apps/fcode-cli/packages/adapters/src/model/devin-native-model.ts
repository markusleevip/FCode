// Devin model UID rules adapted from CLIProxyAPI (MIT).
import { DEVIN_MODEL_METADATA } from "./devin-native-model-data.js";
import { DEVIN_NATIVE_MODEL_UID_PREFIX, DEVIN_NATIVE_MODEL_UID_MAX_TOKENS } from "@fcode/shared";
import { devinFailure } from "./devin-native-protobuf.js";
const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const SUFFIXES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "fast",
  "slow",
  "priority",
  "thinking",
  "thinking-1m",
  "max-1m",
  "none-1m",
];
function clamp(requested: string, levels: string[], fallback: string): string {
  if (!requested || (requested === "none" && !levels.includes("none"))) return fallback;
  if (levels.includes(requested)) return requested;
  const position = ORDER.indexOf(requested);
  if (position < 0) return fallback;
  return (
    levels
      .filter((level) => ORDER.includes(level))
      .sort(
        (a, b) =>
          Math.abs(ORDER.indexOf(a) - position) - Math.abs(ORDER.indexOf(b) - position) ||
          ORDER.indexOf(b) - ORDER.indexOf(a),
      )[0] ?? fallback
  );
}
export function resolveDevinModel(
  raw: string,
  requested: string,
  budget = 0,
): { uid: string; maxTokens: number } {
  if (raw.startsWith(DEVIN_NATIVE_MODEL_UID_PREFIX)) {
    const uid = raw.slice(DEVIN_NATIVE_MODEL_UID_PREFIX.length);
    // 账号目录的原始 UID 不属于旧别名；大小写或 effort 改写会调用另一个模型。
    if (!/^[A-Za-z0-9_.-]+$/.test(uid) || raw.length > 256)
      devinFailure("requires a valid explicit catalog model UID", true);
    return { uid, maxTokens: DEVIN_NATIVE_MODEL_UID_MAX_TOKENS };
  }
  let name = raw.trim().replace(/^devin\//i, "");
  if (!name) name = "swe-2";
  if (
    SUFFIXES.some(
      (suffix) =>
        name.toLowerCase().endsWith(`-${suffix}`) || name.toLowerCase().endsWith(`_${suffix}`),
    )
  ) {
    // 显式 wire UID 仍受所属模型上限约束，不能因已有 effort suffix 放大输出限制。
    const lower = name.toLowerCase();
    const parent = Object.keys(DEVIN_MODEL_METADATA)
      .filter((id) => lower.startsWith(`${id}-`) || lower.startsWith(`${id}_`))
      .sort((a, b) => b.length - a.length)[0];
    return {
      uid: name,
      maxTokens: DEVIN_MODEL_METADATA[lower]?.[1] || DEVIN_MODEL_METADATA[parent]?.[1] || 128000,
    };
  }
  const match = /^(.*?)(?:\(([^)]+)\)|:([^:]+))$/.exec(name);
  if (match) {
    name = match[1];
    requested = match[2] ?? match[3];
  }
  let effort = requested.trim().toLowerCase();
  if (["off", "disabled"].includes(effort)) effort = "none";
  if (["auto", "adaptive"].includes(effort)) effort = "high";
  if (!ORDER.includes(effort) && !["none", "fast"].includes(effort))
    effort =
      budget > 0
        ? budget <= 4096
          ? "low"
          : budget <= 16384
            ? "medium"
            : budget <= 32768
              ? "high"
              : "max"
        : "";
  const base = name.toLowerCase().replaceAll(".", "-");
  const enumBase = base.replaceAll("_", "-");
  const metadata = DEVIN_MODEL_METADATA[base];
  const maxTokens = metadata?.[1] || 128000;
  const aliases: Record<string, string> = {
    "claude-haiku-4-5": "MODEL_PRIVATE_11",
    "gpt-4-1": "MODEL_CHAT_GPT_4_1_2025_04_14",
  };
  if (Object.hasOwn(aliases, base)) return { uid: aliases[base], maxTokens };
  if (base.includes("sonnet-4-5"))
    return { uid: effort && effort !== "none" ? "MODEL_PRIVATE_3" : "MODEL_PRIVATE_2", maxTokens };
  if (enumBase === "model-gpt-5-2")
    return {
      uid: `MODEL_GPT_5_2_${clamp(effort, ["none", "low", "medium", "high", "xhigh"], "low").toUpperCase()}`,
      maxTokens,
    };
  if (enumBase === "model-google-gemini-3-0-flash")
    return {
      uid: `MODEL_GOOGLE_GEMINI_3_0_FLASH_${clamp(effort, ["minimal", "low", "medium", "high"], "high").toUpperCase()}`,
      maxTokens,
    };
  if (enumBase === "model-claude-4-5-opus")
    return {
      uid: `MODEL_CLAUDE_4_5_OPUS${effort && effort !== "none" ? "_THINKING" : ""}`,
      maxTokens,
    };
  if (base === "swe-1-7" || base === "swe-1-6")
    return {
      uid: `${base}${effort === (base === "swe-1-7" ? "medium" : "fast") ? `-${effort}` : ""}`,
      maxTokens,
    };
  if (base === "glm-5-2" || base === "glm-5-2-1m")
    return {
      uid: `glm-5-2${["none", "max"].includes(effort) ? `-${effort}` : ""}${base.endsWith("-1m") ? "-1m" : ""}`,
      maxTokens,
    };
  if (/^claude-(?:opus|sonnet)-4-6(?:-1m)?$/.test(base))
    return {
      uid: base.replace(/(-1m)?$/, `${effort && effort !== "none" ? "-thinking" : ""}$1`),
      maxTokens,
    };
  const canonical = base === "gemini-3-flash" ? "gemini-3-8-flash" : base;
  const levels = (DEVIN_MODEL_METADATA[canonical]?.[0] ?? "").split(",").filter(Boolean);
  let fallback = levels[0] ?? "";
  if (canonical.includes("swe-2")) fallback = "high";
  else if (canonical.startsWith("gpt-5") && levels.includes("none") && levels.includes("low"))
    fallback = "low";
  else if (/gemini|grok|glm|deepseek|kimi|nemotron/.test(canonical) && levels.includes("high"))
    fallback = "high";
  else fallback = ["medium", "high", "low"].find((value) => levels.includes(value)) ?? fallback;
  return {
    uid: levels.length ? `${canonical}-${clamp(effort, levels, fallback)}` : canonical,
    maxTokens: DEVIN_MODEL_METADATA[canonical]?.[1] || maxTokens,
  };
}
