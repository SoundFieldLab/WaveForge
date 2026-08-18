@echo off
chcp 65001 > nul
echo ========================================
echo WaveForge - Full Stack Startup
echo ========================================
echo.

echo Starting Python Beat Service...
echo.
start "Python Beat Service" cmd /k "chcp 65001 >nul && cd python-beat-service && start.bat"

echo Starting Loudness Service (响度测量)...
echo.
start "Loudness Service" cmd /k "chcp 65001 >nul && cd python-beat-service && ..\resources\python-embed\python.exe loudness_server.py"

echo Starting Compensation Service (频响补偿)...
echo.
start "Compensation Service" cmd /k "chcp 65001 >nul && cd python-beat-service && ..\resources\python-embed\python.exe compensation_server.py"

echo Waiting 3 seconds for Python services to initialize...
timeout /t 3 /nobreak > nul

echo.
echo Starting Electron App...
echo.
start "WaveForge Electron" cmd /k "chcp 65001 >nul && npm run dev:electron"

echo.
echo ========================================
echo All services started!
echo ========================================
echo.
echo Python Beat Service: http://localhost:3002
echo Loudness Service: http://localhost:3003
echo Compensation Service: http://localhost:3004
echo Electron App: Will open automatically
echo.
echo To stop services, close both windows
echo.
pause
