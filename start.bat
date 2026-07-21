@echo off
rem === CollabBoard whiteboard launcher (Windows) ===
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo [ERROR] Node.js not found. Install from https://nodejs.org && pause && exit /b 1)
echo === CollabBoard whiteboard ===
echo Starting WebSocket + HTTP API server on ws://localhost:8080 ...
echo Opening the board page (auto-reconnects once server is up).
start "" "%~dp0index.html"
node "%~dp0server.js"
pause
