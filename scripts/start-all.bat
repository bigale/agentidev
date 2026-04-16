@echo off
REM Start bridge + asset server + launch browser (full stack) on Windows

cd /d "%~dp0\.."
echo Starting agentidev stack...
echo.

start "Agentidev Bridge" cmd /k "npm run bridge"
timeout /t 3 /nobreak > nul

echo.
echo Bridge started in separate window.
echo.
echo To launch the browser with extension:
echo   npm run browser
echo.
echo To open the dashboard:
echo   Load the extension at chrome://extensions then click the icon
echo.
pause
