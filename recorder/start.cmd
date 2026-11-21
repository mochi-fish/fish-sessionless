@echo off
rem Keep recording: restart only when the recorder crashes (exit 1). Ctrl+C (0), already running (3), bad config (2) stop here.
chcp 65001 >nul
cd /d "%~dp0"
:loop
node recorder.mjs %*
if not "%errorlevel%"=="1" exit /b %errorlevel%
echo recorder exited with code 1, restarting in 10 s...
timeout /t 10 /nobreak >nul
goto loop
