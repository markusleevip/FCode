// Devin ClientMetadata adapted from CLIProxyAPI (MIT). See third-party/copied-components.json.
import { createHash, randomBytes } from "node:crypto";

const CLIENT = "chisel";
const CLIENT_VERSION = "3000.10.21";
const FINGERPRINT_LENGTH = 732;

function uint(value: number): Buffer {
  const output: number[] = [];
  do {
    output.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(output);
}
function text(id: number, value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint(id * 8 + 2), uint(bytes.length), bytes]);
}

/** Node-only wire metadata; no account/session state, network access or credential persistence. */
export function createDevinClientMetadata(
  token: string,
  deviceSeed: string,
  platform: NodeJS.Platform = process.platform,
): Buffer {
  let fingerprint = "";
  if (!deviceSeed) fingerprint = randomBytes(FINGERPRINT_LENGTH / 2).toString("hex");
  else {
    for (let index = 0; fingerprint.length < FINGERPRINT_LENGTH; index++)
      fingerprint += createHash("sha256").update(`${deviceSeed}-${index}`).digest("hex");
    fingerprint = fingerprint.slice(0, FINGERPRINT_LENGTH);
  }
  return Buffer.concat([
    text(1, CLIENT),
    text(2, CLIENT_VERSION),
    text(3, token),
    text(4, "en"),
    text(5, platform === "win32" ? "windows" : platform),
    text(7, CLIENT_VERSION),
    text(12, CLIENT),
    text(31, fingerprint),
  ]);
}
