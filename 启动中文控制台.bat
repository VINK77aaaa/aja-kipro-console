@echo off
rem AJA Ki Pro 中文控制台启动器
rem 注意：本文件必须保存为 ANSI/GBK 编码 + CRLF 行尾（.gitattributes 已配置 -text 原样存储），
rem       UTF-8 会在中文系统 cmd 下乱码。
setlocal
set "NODE_VER=22.14.0"
set "NODE_SHA256=33b1bc1a8aca11fd5a4f2699e51019c63c0af30cf437701d07af69be7706771b"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VER%/win-x64/node.exe"
if defined AJA_PANEL_PORT (set "PANEL_URL=http://127.0.0.1:%AJA_PANEL_PORT%") else set "PANEL_URL=http://127.0.0.1:8321"

rem pushd 兼容 UNC 共享路径（cd /d 遇 \\server\share 会失败）
pushd "%~dp0"
if errorlevel 1 goto FAILDIR

rem —— 三级查找：系统 PATH → 自带 runtime\node.exe → 自动下载便携版 ——
where node >nul 2>nul
if not errorlevel 1 goto RUN
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
if exist "runtime\node.exe" goto RUN

echo [提示] 本机没有 Node.js，正在自动下载便携版（约 80MB，只需一次，下方有进度条）...
if not exist "runtime" mkdir "runtime"
if errorlevel 1 goto FAILDIR
rem 下载前清场：上一次中断留下的半截 .tmp 必须删掉
del "runtime\node.exe.tmp" >nul 2>nul
curl.exe -L --fail --retry 2 --connect-timeout 20 --progress-bar -o "runtime\node.exe.tmp" "%NODE_URL%"
if errorlevel 1 curl.exe -L --fail --noproxy "*" --connect-timeout 20 --progress-bar -o "runtime\node.exe.tmp" "%NODE_URL%" >nul 2>nul
if errorlevel 1 powershell -NoProfile -Command "try{[Net.ServicePointManager]::SecurityProtocol='Tls12';[Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy;Invoke-WebRequest -Uri '%NODE_URL%' -OutFile 'runtime\node.exe.tmp' -UseBasicParsing}catch{exit 1}" >nul 2>nul
rem 校验体积而不是存在性：半截文件和拦截页 HTML 都到不了 80MB
for %%A in ("runtime\node.exe.tmp") do if %%~zA LSS 80000000 goto FAIL
move /y "runtime\node.exe.tmp" "runtime\node.exe" >nul || goto FAIL
rem 落地自检：能运行才认数（防杀软隔离导致的"文件在但不可用"）
"%~dp0runtime\node.exe" -v >nul 2>nul || (del "runtime\node.exe" >nul 2>nul & goto FAIL)
rem 官方 SHA-256 校验（来源 nodejs.org/dist/v22.14.0/SHASUMS256.txt）
certutil -hashfile "runtime\node.exe" SHA256 | find /i "%NODE_SHA256%" >nul || (del "runtime\node.exe" >nul 2>nul & goto FAIL)
set "PATH=%~dp0runtime;%PATH%"
echo [完成] 便携版 Node 已就绪（runtime\node.exe），以后启动不再需要网络。
goto RUN

:FAILDIR
echo [失败] 目录不可写（例如放在 Program Files、只读共享或光盘里），无法准备运行时。
echo        请把整个文件夹移到可写位置后重试。
echo.
pause
exit /b 1

:FAIL
del "runtime\node.exe.tmp" >nul 2>nul
echo [失败] 自动下载没有成功（可能没联网、被安全软件拦截、或本目录不可写）。
echo.
echo 方案一（推荐，零安装）：在主控电脑上双击"启动中文控制台.bat"，
echo        然后在本机浏览器直接打开  http://主控电脑IP:8321
echo 方案二：手动安装 Node.js 后再运行本脚本：
echo        winget install OpenJS.NodeJS.LTS
echo.
pause
exit /b 1

:RUN
start "" %PANEL_URL%
echo AJA Ki Pro 中文控制台启动中...（关闭本窗口即停止服务）
echo 若浏览器打开过早提示无法访问，刷新一下即可。
chcp 65001 >nul
node server.js
pause
