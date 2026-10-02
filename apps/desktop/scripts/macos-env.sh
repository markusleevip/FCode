#!/usr/bin/env bash
# build.sh / run.sh 共用的环境检查。只依赖 PATH 中的 node、pnpm，不写死任何目录或盘符。
# 用 source 加载；调用方负责先 cd 到 apps/desktop。

REQUIRED_NODE_MAJOR=24
REQUIRED_PNPM_MAJOR=10

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

# 未在 PATH 中的 nvm / fnm / mise / volta 安装的 Node，尝试按项目声明的版本激活。
activate_node_manager() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate bash --shims 2>/dev/null)" || true
  fi
  if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 && nvm use "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env 2>/dev/null)" || true
  fi
}

setup_macos_env() {
  [ "$(uname -s)" = "Darwin" ] || fail "This script is for macOS only; on Windows use build.cmd / run.cmd."

  activate_node_manager
  command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js ${REQUIRED_NODE_MAJOR}.x (see mise.toml), e.g.: brew install node@${REQUIRED_NODE_MAJOR}"

  local node_version node_major
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  [ "$node_major" = "$REQUIRED_NODE_MAJOR" ] \
    || fail "Node major version must be ${REQUIRED_NODE_MAJOR}, found ${node_version}."
  local pinned_node
  pinned_node="$(sed -n 's/^node = "\(.*\)"/\1/p' mise.toml 2>/dev/null | head -n1)"
  if [ -n "$pinned_node" ] && [ "$node_version" != "v${pinned_node}" ]; then
    echo "[WARN] mise.toml pins Node ${pinned_node}, found ${node_version} (same major version, continuing)."
  fi

  # pnpm 不在 PATH 时退回 corepack（Node 自带），避免要求用户全局安装。
  local pinned_pnpm
  pinned_pnpm="$(sed -n 's/^pnpm = "\(.*\)"/\1/p' mise.toml 2>/dev/null | head -n1)"
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    PNPM=(corepack "pnpm@${pinned_pnpm:-${REQUIRED_PNPM_MAJOR}}")
  else
    fail "pnpm not found. Install pnpm ${pinned_pnpm:-$REQUIRED_PNPM_MAJOR}, e.g.: corepack enable or npm i -g pnpm@${pinned_pnpm:-$REQUIRED_PNPM_MAJOR}"
  fi

  local pnpm_version pnpm_major
  pnpm_version="$("${PNPM[@]}" --version)" || fail "pnpm failed to run."
  pnpm_major="${pnpm_version%%.*}"
  [ "$pnpm_major" = "$REQUIRED_PNPM_MAJOR" ] \
    || fail "pnpm major version must be ${REQUIRED_PNPM_MAJOR}, found ${pnpm_version}."
  if [ -n "$pinned_pnpm" ] && [ "$pnpm_version" != "$pinned_pnpm" ]; then
    echo "[WARN] mise.toml pins pnpm ${pinned_pnpm}, found ${pnpm_version} (same major version, continuing)."
  fi

  # node-pty 在非 Windows 上会在 postinstall 重编译，Swift 窗口辅助程序也依赖 Xcode CLT。
  xcode-select -p >/dev/null 2>&1 \
    || fail "Xcode Command Line Tools are missing. Run: xcode-select --install"

  # 不设置 COREPACK_ENABLE_PROJECT_SPEC=0：pnpm 若是 corepack 代理，需要读取 package.json 的 packageManager 来选版本。
  export FCODE_SKIP_REMOTE_ASSETS=1

  echo "[INFO] node ${node_version}, pnpm ${pnpm_version}, $(uname -m)"
}
