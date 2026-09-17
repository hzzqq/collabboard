#!/usr/bin/env bash
# === CollabBoard 协作白板 启动脚本（Git Bash / macOS / Linux）===
cd "$(dirname "$0")" || exit 1
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
if [ ! -x "$NODE" ]; then
  echo "[错误] 未找到 WorkBuddy Node 运行时：$NODE"
  exit 1
fi

# 避开 Windows 保留端口段 8000-8300；与 index.html 中 WebSocket 端口保持一致
PORT="${PORT:-18080}"
URL="http://localhost:${PORT}/"

open_url() {
  if command -v cygstart >/dev/null 2>&1; then cygstart "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  elif command -v open >/dev/null 2>&1; then open "$1"
  else cmd //c start "" "$1" 2>/dev/null || powershell -c "Start-Process '$1'" 2>/dev/null; fi
}

echo "=== CollabBoard 协作白板 ==="
echo "启动 WebSocket + HTTP API 服务：ws://localhost:${PORT}  (房间用 ?room=NAME 区分)"
echo "打开白板页面（服务就绪后会自动重连）..."
( sleep 1; open_url "$URL" ) &
PORT="$PORT" "$NODE" "$(dirname "$0")/server.js"
