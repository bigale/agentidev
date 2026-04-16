@echo off
REM Start the agentidev bridge server on Windows
REM Double-click to run, or launch from PowerShell

cd /d "%~dp0\.."
echo Starting agentidev bridge server on port 9876...
echo.
echo Keep this window open. Close it to stop the bridge.
echo.
npm run bridge
pause
