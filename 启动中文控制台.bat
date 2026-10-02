@echo off
rem AJA Ki Pro 中文控制台启动器（本文件必须保存为 ANSI/GBK 编码，UTF-8 会在中文系统 cmd 下乱码）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

start "" http://127.0.0.1:8321
echo AJA Ki Pro 中文控制台启动中...（关闭本窗口即停止服务）
chcp 65001 >nul
node server.js
pause
exit /b 0

:NONODE
echo [提示] 这台电脑没有安装 Node.js，无法以独立服务方式启动面板。
echo.
echo 方案一（推荐，零安装）：在主控电脑上双击"启动中文控制台.bat"，
echo        然后在本机浏览器直接打开  http://主控电脑IP:8321
echo 方案二：本机安装 Node.js 后再运行本脚本：
echo        winget install OpenJS.NodeJS.LTS
echo.
pause
exit /b 1
