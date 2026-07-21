#!/usr/bin/env bash
# === CollabBoard 协作白板 启动脚本（Git Bash / macOS / Linux）===
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "[错误] 未找到 Node.js，请先安装：https://nodejs.org"; exit 1; }

PORT="${PORT:-8080}"          # WebSocket + HTTP API 端口（客户端固定连 8080）
PAGE="$(dirname "$0")/index.html"

open_url() {
  if command -v cygstart >/dev/null 2>&1; then cygstart "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  elif command -v open >/dev/null 2>&1; then open "$1"
  else cmd //c start "" "$1" 2>/dev/null || powershell -c "Start-Process '$1'" 2>/dev/null; fi
}

echo "=== CollabBoard 协作白板 ==="
echo "启动 WebSocket + HTTP API 服务：ws://localhost:${PORT}  (房间用 ?room=NAME 区分)"
echo "打开白板页面（服务就绪后会自动重连）..."
( sleep 1; open_url "$PAGE" ) &
PORT="$PORT" node "$(dirname "$0")/server.js"
