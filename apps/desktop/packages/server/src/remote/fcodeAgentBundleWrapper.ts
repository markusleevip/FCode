// 远端 FCode Agent 以「独立 node + 编译产物 fcode.cjs」的形态运行，而不是各平台内嵌 node 的原生二进制。
// 远端部署时本来就有一份独立 node（用于跑 fcode-server.cjs），agent 复用它执行 fcode.cjs 即可。
//
// 部署布局：把 fcode.cjs 放到 agents/<provider>/fcode.cjs，再写一个同名 wrapper —— 就是 resolver
// 期望找到的可执行入口（如 agents/glm/fcode-agent）—— 由它用远端 node 执行 fcode.cjs。
// 这样 provider runtime resolver 不需要区分原生/JS，照旧找 fcode-agent 这个可执行文件即可。
// 开发态与生产态共用同一份 wrapper 语义。

import {
  LEGACY_BRAND,
  LEGACY_ENV_PREFIX,
  LEGACY_PRODUCT_DIRECTORY,
} from "@fcode/shared/branding-compatibility";

export const REMOTE_AGENT_BUNDLE_NAME = "fcode.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'if [ "${FCODE_SERVER_RUNTIME_ROOT+x}" = x ]; then',
    '  runtime_root="$FCODE_SERVER_RUNTIME_ROOT"',
    `elif [ "\${${LEGACY_ENV_PREFIX}SERVER_RUNTIME_ROOT+x}" = x ]; then`,
    `  runtime_root="$${LEGACY_ENV_PREFIX}SERVER_RUNTIME_ROOT"`,
    'elif [ ! -d "$HOME/.fcode/server" ] && [ -d "$HOME/' +
      LEGACY_PRODUCT_DIRECTORY +
      '/server" ]; then',
    `  runtime_root="$HOME/${LEGACY_PRODUCT_DIRECTORY}/server"`,
    'else runtime_root="$HOME/.fcode/server"; fi',
    `bundle="$runtime_root/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}"`,
    `if [ ! -f "$bundle" ]; then bundle="$runtime_root/agents/${runtimeResourceDir}/${LEGACY_BRAND}.cjs"; fi`,
    'exec "$runtime_root/node" "$bundle" "$@"',
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
