// Antigravity wire profile adapted from CLIProxyAPI (MIT).
import { FCODE_VERSION } from "../version.js";

/** 厂商协商版本与 FCode 产品版本分别声明；平台和 Node 保留真实运行环境。 */
export const ANTIGRAVITY_PROTOCOL_VERSION = "2.9.1";

export function createAntigravityNativeHeaders(): Record<string, string> {
  return {
    "User-Agent": `antigravity/hub/${ANTIGRAVITY_PROTOCOL_VERSION} ${process.platform}/${process.arch} FCode/${FCODE_VERSION}`,
    "X-Goog-Api-Client": `gl-node/${process.versions.node}`,
  };
}
