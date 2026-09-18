@echo off
setlocal enabledelayedexpansion
title Pi Agent
rem ---------------------------------------------------------------------------
rem  Opens the Pi Agent UI in its own window - no build step, no toolchain.
rem
rem  Same UI that start-webui.bat serves, launched in Edge/Chrome "app mode" so
rem  it gets its own window without tabs or an address bar. Use this one when
rem  you do not want to install Visual Studio just for the native shell in
rem  pi-desktop\ (start-app.bat). Falls back to the default browser.
rem
rem  The bridge is started automatically when nothing listens on PORT.
rem ---------------------------------------------------------------------------

set "PORT=3080"
set "URL=http://localhost:%PORT%/"

set "BRIDGE_UP="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do set "BRIDGE_UP=%%P"
if defined BRIDGE_UP goto open

echo.
echo   The bridge is not running - starting it in a second window.
echo.
start "Pi Agent WebUI" "%~dp0start-webui.bat"
for /l %%I in (1,1,45) do (
  timeout /t 1 /nobreak >nul
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":%PORT% "') do set "BRIDGE_UP=%%P"
  if defined BRIDGE_UP goto open
)
echo   The bridge is taking a while (a first run installs dependencies).
echo   Opening the window anyway - reload it once the bridge settles.

:open
set "BROWSER="
for %%E in (
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist %%E set "BROWSER=%%~E"
)

if defined BROWSER (
  echo   Opening %URL% as an app window...
  start "" "%BROWSER%" --app=%URL% --window-size=1280,880
) else (
  echo   No Edge or Chrome found - opening in the default browser instead.
  start "" "%URL%"
)
exit /b 0
