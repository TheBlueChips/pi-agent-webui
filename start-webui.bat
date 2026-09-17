@echo off
setlocal enabledelayedexpansion
title Pi Agent WebUI
rem Pi Agent WebUI launcher.
rem
rem First run (or after switch_pi_agent_source.bat): pick where the pi agent
rem lives - natively on Windows, or inside a Docker container. The choice is
rem saved to bridge\agent-source.txt and reused on later launches.

cd /d "%~dp0bridge"
if not exist node_modules (
  echo Installing bridge dependencies...
  call npm install --no-fund --no-audit
)

set "SOURCE_FILE=%~dp0bridge\agent-source.txt"
set "SOURCE="
set "CONTAINER="

rem -- reuse a saved choice unless switch_pi_agent_source.bat deleted it --
if exist "%SOURCE_FILE%" if "%~1"=="" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%SOURCE_FILE%") do (
    if /i "%%A"=="source" set "SOURCE=%%B"
    if /i "%%A"=="container" set "CONTAINER=%%B"
  )
)
if /i "!SOURCE!"=="native" goto :native
if /i "!SOURCE!"=="docker" if not "!CONTAINER!"=="" goto :docker

:choose
echo.
echo  Where does your pi agent run?
echo    1. Natively on Windows  (pi CLI installed, no Docker)
echo    2. Inside a Docker container
choice /c 12 /n /m "Select [1/2]: "
if errorlevel 2 goto :choose_docker
goto :choose_native

:choose_native
set "SOURCE=native"
>"%SOURCE_FILE%" echo source=native
goto :native

:choose_docker
set "SOURCE=docker"
echo.
echo  Containers on this machine:
set /a i=1
for /f "tokens=1,2,3" %%A in ('docker ps -a --format "{{.Names}} {{.Image}} {{.Status}}"') do (
  set "name_!i!=%%A"
  echo    !i!. %%A  [%%B]
  set /a i+=1
)
set /a count=i-1
if !count! LSS 1 (
  echo  No Docker containers found.
  pause
  exit /b 1
)
set "PICK="
set /p PICK="Pick container number [1-!count!]: "
if not defined PICK (
  echo  No selection made.
  pause
  exit /b 1
)
set /a idx=1
for /f "tokens=1" %%A in ('docker ps -a --format "{{.Names}}"') do (
  if !idx! EQU !PICK! set "CONTAINER=%%A"
  set /a idx+=1
)
if not defined CONTAINER (
  echo  Invalid selection.
  pause
  exit /b 1
)
rem sanity: does the chosen container have pi?
docker exec "!CONTAINER!" sh -c "command -v pi >/dev/null 2>&1" >nul 2>nul
if errorlevel 1 echo  WARNING: no "pi" command found inside "!CONTAINER!" - it may still work if pi is on another path.
>"%SOURCE_FILE%" echo source=docker
>>"%SOURCE_FILE%" echo container=!CONTAINER!

:docker
:native
if /i "!SOURCE!"=="native" (
  where pi >nul 2>nul
  if errorlevel 1 (
    echo ERROR: "pi" was not found on PATH.
    echo        Install it with: npm install -g @mariozechner/pi-coding-agent
    pause
    exit /b 1
  )
  echo Using natively installed pi CLI.
  set "PI_COMMAND=pi --mode rpc"
  set "PI_SESSION_DIR=!USERPROFILE!\.pi\agent\sessions"
) else (
  echo Using Docker container "!CONTAINER!".
  docker start "!CONTAINER!" >nul 2>nul
  set "PI_COMMAND=docker exec -i !CONTAINER! pi --mode rpc"
  set "PI_SESSION_DIR=docker:!CONTAINER!:/root/.pi/agent/sessions"
)

set PORT=3080
echo.
echo Pi Agent WebUI starting on http://localhost:3080
echo (to change the pi agent source later, run switch_pi_agent_source.bat)
endlocal & (
  set "PI_COMMAND=%PI_COMMAND%"
  set "PI_SESSION_DIR=%PI_SESSION_DIR%"
  set "PORT=%PORT%"
)
echo.
echo  Pi Agent WebUI is running at  http://localhost:%PORT%
echo.
echo  To STOP it: press Ctrl+C in this window, or close this window.
echo  (stopping also kills the pi agent + whisper server - nothing is left running)
echo.
node "%~dp0bridge\server.js"
echo.
echo  Pi Agent WebUI stopped.
timeout /t 2 >nul
pause
