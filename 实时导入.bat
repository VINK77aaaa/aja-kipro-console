@echo off
title Realtime Import Launcher

rem start the watcher only if it is not already running
tasklist /FI "WINDOWTITLE eq DaVinciWatch*" | find /I "cmd.exe" >nul
if errorlevel 1 (
  start "DaVinciWatch" /min cmd /k py -3 "%~dp0watch_images.py"
  echo Watcher started. Drop new images into the folder and they go to the timeline.
) else (
  echo Watcher is already running.
)

rem launch Resolve if it is not running
tasklist /FI "IMAGENAME eq Resolve.exe" | find /I "Resolve.exe" >nul
if errorlevel 1 start "" "C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe"

echo.
pause
