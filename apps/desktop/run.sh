#!/usr/bin/env bash
# macOS 启动脚本：使用隔离的本地数据目录启动桌面端（dev:desktop:test）。
# 数据保存在本目录下的 .felixcode-local-data/.fcode/，不影响用户主目录的 .fcode。
# 用法: ./run.sh        （可从任意目录调用；退出按 Ctrl+C）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck disable=SC1091
. scripts/macos-env.sh
setup_macos_env

export FCODE_DATA_BASE_DIR="$PWD/.felixcode-local-data"
export FCODE_DATA_DIR_NAME=".fcode"
export FCODE_DESKTOP_HOME_DIR="$FCODE_DATA_BASE_DIR"

node scripts/prepare-isolated-desktop-data.mjs

[ -f node_modules/typescript/bin/tsc ] || fail "Dependencies are missing. Run ./build.sh first."

if lsof -nP -iTCP:5174 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 5174 is already in use. Stop the previously started desktop dev process first."
fi

exec "${PNPM[@]}" dev:desktop:test
