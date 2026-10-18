#!/usr/bin/env bash
# Start both development services; keep their logs in this terminal.
set -euo pipefail

ANERA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ANERA_ROOT"

case "${1:-}" in
  -h|--help)
    printf '用法：./start.sh\n同时启动 Anera 前后端；按 Ctrl+C 停止。\nmacOS 也可双击 start.command。\n'
    exit 0
    ;;
  '') ;;
  *) printf '不支持的参数：%s（使用 --help 查看用法）\n' "$1" >&2; exit 1 ;;
esac

# Finder-launched terminals may not include locally installed Node.js in PATH.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '请先安装 Node.js 22 或更高版本（包含 npm）。\n' >&2
  exit 1
fi
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  printf '需要 Node.js 22 或更高版本，当前为 %s。\n' "$(node --version)" >&2
  exit 1
fi

if [ ! -f .env ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  printf '请先复制 .env.example 为 .env，并填写 DEEPSEEK_API_KEY。\n' >&2
  exit 1
fi

# The Vite proxy targets 4174. Refuse a duplicate start instead of killing a
# process that could belong to another project.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:4174 -sTCP:LISTEN -t >/dev/null 2>&1; then
  printf '后端端口 4174 已被占用。若 Anera 已运行，请在原启动窗口按 Ctrl+C 后重试。\n' >&2
  exit 1
fi

if [ ! -x node_modules/.bin/vite ] || [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/concurrently ]; then
  printf '安装项目依赖…\n'
  npm ci
fi

printf '启动 Anera：%s\n' "$ANERA_ROOT"
printf '后端：http://127.0.0.1:4174\n前端地址见下方 Vite 的 Local 输出（默认 5173，占用时自动换端口）。\n按 Ctrl+C 同时停止前后端。\n\n'
# Keep the backend aligned with the existing development proxy even if an
# alternate production port is configured in .env.
export ANERA_PORT=4174
exec npm run dev
