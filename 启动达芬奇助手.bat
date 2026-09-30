@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 达芬奇助手

echo ================================================================
echo   达芬奇助手
echo     1) 图片实时导入监视器  （watch_images.py）
echo     2) AJA Ki Pro 中文控制台（http://127.0.0.1:8321）
echo ================================================================
echo.

rem ---- 1) 图片实时导入监视器 ----
rem 脚本自带单实例保护（占用本机回环端口 8322），重复启动会自动退出，不会起第二个。
start "DaVinciWatch" /min cmd /c "chcp 65001 >nul & py -3 watch_images.py"

rem ---- 2) AJA 中文控制台（多台设备在 aja-中文控制台\devices.txt 里配置）----
start "AJA中文控制台" /min cmd /c "chcp 65001 >nul & node server.js"

rem ---- 3) 达芬奇没开就顺手拉起来 ----
tasklist /FI "IMAGENAME eq Resolve.exe" 2>nul | find /I "Resolve.exe" >nul
if errorlevel 1 (
  echo 达芬奇未运行，正在启动...
  start "" "C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe"
) else (
  echo 达芬奇已在运行。
)

rem ---- 4) 稍等面板起来后打开浏览器 ----
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8321

echo.
echo 已全部启动：两个最小化窗口在任务栏（DaVinciWatch / AJA中文控制台）。
echo   - 关闭对应窗口即停止该项服务
echo   - 面板底部「健康状态」可查看监视器心跳、各设备在线情况
echo   - 丢图片进「图片」文件夹即可自动上时间线
echo.
pause
