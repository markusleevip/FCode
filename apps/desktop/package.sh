#!/usr/bin/env bash
# macOS 打包脚本：生成 dmg/zip 并放入 <仓库根>/releases/macos/<version>/。
# Usage: ./package.sh [arm64|x64] [--overwrite]   defaults to the host architecture; callable from any directory.
#   --overwrite: replace an existing installer of the same version (by default an existing
#   release is refused so a published package is never changed by accident).
# 环境变量: FCODE_ENABLE_MAC_SIGN=1 并提供签名证书时才签名，默认产出未签名安装包。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck disable=SC1091
. scripts/macos-env.sh
setup_macos_env

case "$(uname -m)" in
  arm64) DEFAULT_ARCH=arm64 ;;
  x86_64) DEFAULT_ARCH=x64 ;;
  *) fail "Unsupported host architecture: $(uname -m)" ;;
esac
ARCH="$DEFAULT_ARCH"
OVERWRITE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    arm64|x64) ARCH="$arg" ;;
    --overwrite) OVERWRITE_ARGS=(--overwrite) ;;
    *) fail "Usage: ./package.sh [arm64|x64] [--overwrite] (got: $arg)" ;;
  esac
done

if [ ! -f node_modules/typescript/bin/tsc ]; then
  echo "[INFO] Installing workspace dependencies..."
  "${PNPM[@]}" install --frozen-lockfile
fi

echo "[INFO] Packaging macOS ${ARCH} ..."
node scripts/stage-desktop-release.mjs --os mac --arch "$ARCH" ${OVERWRITE_ARGS[@]+"${OVERWRITE_ARGS[@]}"}

VERSION="$(node -p "require('./package.json').version")"
RELEASE_DIR="$(cd ../.. && pwd)/releases/macos/${VERSION}"
echo "[INFO] Release artifacts in ${RELEASE_DIR}:"
ls -lh "$RELEASE_DIR"
