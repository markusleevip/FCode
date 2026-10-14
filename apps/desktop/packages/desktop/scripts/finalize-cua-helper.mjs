import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER_APP_NAME } from "../../cua/broker-helper-constants.js";

/** Bind a local packaged helper to the final application code before the outer app is signed. */
export function finalizePackagedComputerUseHelper(resources) {
  const root = join(resources, "cua-helper");
  const capability = JSON.parse(readFileSync(join(root, "capability.json"), "utf8"));
  if (capability.available === false) return false;
  if (capability.signing === "developer-id") return false;
  if (capability.signing !== "packaged-adhoc" || capability.appName !== HELPER_APP_NAME) {
    throw new Error("[cua-helper] The package does not contain a compatible packaged Helper.");
  }
  const asar = join(resources, "app.asar");
  const stat = lstatSync(asar);
  if (!stat.isFile() || stat.size === 0 || stat.size > 512 * 1024 * 1024) {
    throw new Error("[cua-helper] The packaged application archive is invalid.");
  }
  const hash = createHash("sha256");
  const fd = openSync(asar, "r");
  try {
    const bytes = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, count));
  } finally { closeSync(fd); }
  const bundle = join(root, HELPER_APP_NAME);
  const policyPath = join(bundle, "Contents/Resources/host-policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.packagedHostBundleIdentifiers) ||
      policy.packagedHostBundleIdentifiers.length === 0 || policy.packagedHostBundleIdentifiers.some(
        (value) => !["dev.fcode.app", "dev.fcode.app.preview"].includes(value))) {
    throw new Error("[cua-helper] The packaged host policy is invalid.");
  }
  writeFileSync(policyPath, JSON.stringify({ ...policy, packagedHostAppAsarSHA256: hash.digest("hex") }));
  execFileSync("codesign", ["--force", "--sign", "-", bundle], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", bundle], { stdio: "inherit" });
  return true;
}
