@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://127.0.0.1:8321
echo AJA Ki Pro 中文控制台启动中...（关闭本窗口即停止服务）
node server.js
pause
