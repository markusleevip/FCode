import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const legacyPattern = /zcode/gi;
// 不检查实际凭据或本地用户文件；只检查 Git 管理的交付文件和未忽略的新源码。
const sensitive = /(^|\/)(\.env(?:\..*)?|credentials(?:\.json)?|secrets?(?:\.json)?)$/i;
const files = execFileSync("git", [
  "-C",
  root,
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
])
  .toString()
  .split("\0")
  .filter(Boolean);
const allowed = JSON.parse(
  await readFile(new URL("./branding-residuals.json", import.meta.url), "utf8"),
);
const entries = new Map(allowed.entries.map((entry) => [`${entry.file}\0${entry.line}`, entry]));
const findings = [];
const counts = {
  files: 0,
  lines: 0,
  occurrences: 0,
  paths: 0,
  attribution: 0,
  compatibility: 0,
  external: 0,
};
for (const file of files) {
  if (sensitive.test(file) || file === "apps/desktop/scripts/branding-residuals.json") continue;
  const absolute = resolve(root, file);
  if (!(await stat(absolute).catch(() => null))?.isFile()) continue;
  if (/zcode/i.test(file)) {
    counts.paths++;
    findings.push({ file, reason: "legacy path" });
  }
  legacyPattern.lastIndex = 0;
  const bytes = await readFile(absolute);
  if (bytes.includes(0) && !/\.(?:ts|tsx|mjs|js)$/.test(file)) continue;
  const text = bytes.toString("utf8");
  let matched = false;
  for (const line of text.split(/\r?\n/)) {
    const matches = line.match(legacyPattern);
    if (!matches) continue;
    matched = true;
    counts.lines++;
    counts.occurrences += matches.length;
    const legalFile = /(^|\/)(LICENSE[^/]*|NOTICE(?:\.md)?|THIRD-PARTY-NOTICES(?:\.md)?)$/i.test(
      file,
    );
    const entry = entries.get(`${file}\0${line}`);
    if (legalFile || /copyright.*zcode/i.test(line)) counts.attribution += matches.length;
    else if (entry) counts[entry.category] += matches.length;
    else findings.push({ file, reason: "unclassified content", line });
  }
  if (matched) counts.files++;
}
console.log(JSON.stringify({ counts, unclassified: findings.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
