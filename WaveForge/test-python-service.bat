@echo off
chcp 65001 > nul
echo ========================================
echo Test Python Beat Service
echo ========================================
echo.

echo Checking curl...
where curl >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: curl not found
    echo Please use Windows 10/11 built-in curl
    echo.
    pause
    exit /b 1
)

echo Testing health check endpoint (http://localhost:5001/health)...
echo.
curl -s http://localhost:5001/health
set CURL_ERROR=%errorlevel%

if %CURL_ERROR% neq 0 (
    echo.
    echo ========================================
    echo Python Beat Service is NOT running!
    echo ========================================
    echo.
    echo Please start the service:
    echo 1. Open new command window
    echo 2. cd python-beat-service
    echo 3. Run start.bat
    echo.
    echo Or double click: python-beat-service\start.bat
    echo.
    pause
    exit /b 1
)

echo.
echo.
echo ========================================
echo Python Beat Service is running!
echo ========================================
echo.
echo Service URL: http://localhost:5001
echo Ready to use Smart AutoMix!
echo.
pause
