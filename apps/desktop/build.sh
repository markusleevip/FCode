#!/usr/bin/env bash
# macOS 编译脚本：检查工具链，必要时安装依赖，然后执行 build:bootstrap。
# 用法: ./build.sh            仅编译（可从任意目录调用）
#       ./build.sh --release  编译后继续打包，产物见 package.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RELEASE=0
case "${1:-}" in
  "") ;;
  --release) RELEASE=1 ;;
  *) echo "[ERROR] Unknown argument: $1 (only --release is supported)" >&2; exit 1 ;;
esac

# shellcheck disable=SC1091
. scripts/macos-env.sh
setup_macos_env

if [ ! -f node_modules/typescript/bin/tsc ]; then
  echo "[INFO] Installing workspace dependencies..."
  "${PNPM[@]}" install --frozen-lockfile
fi

"${PNPM[@]}" run build:bootstrap

if [ "$RELEASE" = 1 ]; then
  exec ./package.sh
fi
