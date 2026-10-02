@echo off
rem AJA Ki Pro 中文控制台启动器
rem 注意：本文件必须保存为 ANSI/GBK 编码 + CRLF 行尾（.gitattributes 已配置），
rem       UTF-8 会在中文系统 cmd 下乱码，裸 LF 会让 goto 跳转不可靠。
cd /d "%~dp0"

rem —— 找 Node：系统 PATH 优先，其次本目录自带的 runtime\node.exe ——
where node >nul 2>nul
if not errorlevel 1 goto RUN
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
if exist "%~dp0runtime\node.exe" goto RUN

rem —— 没有就自动下载便携版 node.exe（约 80MB，只需一次，之后离线可用）——
echo [提示] 本机没有 Node.js，正在自动下载便携版（约 80MB，只需一次，请耐心等待）...
if not exist "%~dp0runtime" mkdir "%~dp0runtime"
curl.exe -L --fail --retry 2 -o "%~dp0runtime\node.exe.tmp" "https://nodejs.org/dist/v22.14.0/win-x64/node.exe" >nul 2>nul
if errorlevel 1 powershell -NoProfile -Command "try{[Net.ServicePointManager]::SecurityProtocol='Tls12';Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/win-x64/node.exe' -OutFile '%~dp0runtime\node.exe.tmp' -UseBasicParsing}catch{exit 1}" >nul 2>nul
if not exist "%~dp0runtime\node.exe.tmp" goto FAIL
move /y "%~dp0runtime\node.exe.tmp" "%~dp0runtime\node.exe" >nul
set "PATH=%~dp0runtime;%PATH%"
echo [完成] 便携版 Node 已就绪（runtime\node.exe），以后启动不再需要网络。
goto RUN

:FAIL
echo [失败] 自动下载没有成功（可能没联网、或被安全软件拦截）。
echo.
echo 方案一（推荐，零安装）：在主控电脑上双击"启动中文控制台.bat"，
echo        然后在本机浏览器直接打开  http://主控电脑IP:8321
echo 方案二：手动安装 Node.js 后再运行本脚本：
echo        winget install OpenJS.NodeJS.LTS
echo.
pause
exit /b 1

:RUN
start "" http://127.0.0.1:8321
echo AJA Ki Pro 中文控制台启动中...（关闭本窗口即停止服务）
chcp 65001 >nul
node server.js
pause
