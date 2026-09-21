@echo off
setlocal enabledelayedexpansion
title Pi Agent - Desktop App (React Native for Windows)
rem ---------------------------------------------------------------------------
rem  Launches the native Pi Agent app (the React Native one in pi-desktop\).
rem
rem  The bridge starts with it, quietly, and goes away again when the app window
rem  is closed - so the app is the only thing you have to open and close. A
rem  bridge that was already running is left alone, since a browser tab may be
rem  using it.
rem
rem  The first run builds the app, which takes a while: it compiles the C++
rem  React Native Windows runtime and the native modules.
rem ---------------------------------------------------------------------------

set "EXE=%~dp0pi-desktop\windows\x64\Release\PiAgent.exe"
set "PROJ=%~dp0pi-desktop"

rem --- the bridge -------------------------------------------------------------
set "BRIDGE_UP="
set "OWNS_BRIDGE="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":3080 "') do set "BRIDGE_UP=%%P"
if not defined BRIDGE_UP (
  if exist "%~dp0bridge\agent-source.txt" (
    rem Source already chosen: start it with no console window at all.
    echo   Starting the bridge in the background...
    powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '%~dp0start-webui.bat'" >nul 2>nul
  ) else (
    rem First run: the source picker needs an answer, so show that window once.
    echo   First run: choose where your pi agent lives in the window that opens.
    start "Pi Agent WebUI" "%~dp0start-webui.bat"
  )
  for /l %%I in (1,1,60) do (
    timeout /t 1 /nobreak >nul
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:":3080 "') do set "BRIDGE_UP=%%P"
    rem !BRIDGE_UP!, not %%P: the loop variable only expands inside the
    rem for's own do-clause, and this line sits after it.
    if defined BRIDGE_UP set "OWNS_BRIDGE=!BRIDGE_UP!"
    if defined OWNS_BRIDGE goto bridge_ok
  )
  echo   The bridge is taking a while - opening the app anyway.
)
:bridge_ok

rem --- dependencies present? -------------------------------------------------
if not exist "%PROJ%\node_modules" (
  echo   Installing the app's dependencies first - first run only...
  pushd "%PROJ%"
  call npm install --no-fund --no-audit
  set "INSTALL_RC=!errorlevel!"
  popd
  if not "!INSTALL_RC!"=="0" (
    echo.
    echo   npm install failed - check your network / npm registry.
    pause
    exit /b 1
  )
)

rem --- built already? --------------------------------------------------------
if exist "%EXE%" goto launch

echo.
echo   The app has not been built yet.
echo   Building it now. This can take 5-20 minutes the first time.
echo.
pushd "%PROJ%"
call npm run windows:release
set "BUILD_RC=!errorlevel!"
popd
if not "!BUILD_RC!"=="0" (
  echo.
  echo   Build failed. See pi-desktop\README.md ^> "Building for Windows".
  pause
  exit /b 1
)
if not exist "%EXE%" (
  echo.
  echo   Build reported success but !EXE! is missing.
  pause
  exit /b 1
)

:launch
echo.
echo  ==========================================================
echo   Pi Agent - desktop app
echo  ==========================================================
echo.
echo   Starting the app... (the window opens in a moment)
echo   In the app's setup screen enter your PC's IP and port 3080.
echo.
rem /wait keeps this script alive for exactly as long as the app window does, so
rem the bridge can be shut down together with it.
start /wait "" "%EXE%"
if defined OWNS_BRIDGE (
  echo.
  echo   App closed - stopping the bridge we started, PID %OWNS_BRIDGE%.
  taskkill /PID %OWNS_BRIDGE% /T /F >nul 2>nul
)
exit /b 0
