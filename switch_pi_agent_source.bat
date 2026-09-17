@echo off
rem Re-run the pi agent source choice for the Pi Agent WebUI
rem (native Windows install vs Docker container), then start the UI.
title Switch Pi Agent Source
echo.
del "%~dp0bridge\agent-source.txt" >nul 2>nul
echo Saved pi agent source cleared - pick a new one.
call "%~dp0start-webui.bat"
