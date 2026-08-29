@echo off
chcp 65001 > nul
echo ========================================
echo Beat Analysis Service - Startup
echo ========================================
echo.

REM Use project's embedded Python
set PYTHON_EXE=..\resources\python-embed\python.exe
set PIP_EXE=..\resources\python-embed\Scripts\pip.exe

REM Check if Python exists
if not exist "%PYTHON_EXE%" (
    echo ERROR: Built-in Python not found at %PYTHON_EXE%
    echo Please ensure the project structure is intact
    echo.
    pause
    exit /b 1
)

echo [1/3] Using built-in Python:
"%PYTHON_EXE%" --version
echo.

REM Check if dependencies are installed
echo [2/3] Checking dependencies...
"%PYTHON_EXE%" -c "import flask" 2>nul
if %errorlevel% neq 0 (
    echo Dependencies not installed. Installing from local packages...
    echo This will be fast - using offline packages...
    echo.
    "%PIP_EXE%" install --no-index --find-links=packages -r requirements.txt
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Failed to install dependencies from local packages
        echo Trying online installation as fallback...
        echo.
        "%PIP_EXE%" install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        if %errorlevel% neq 0 (
            echo.
            echo ERROR: Failed to install dependencies
            echo Please check your network or contact support
            echo.
            pause
            exit /b 1
        )
    )
    echo Dependencies installed successfully
) else (
    echo Dependencies already installed
)
echo.

echo [3/3] Starting service...
echo.
echo ========================================
echo Beat Analysis Service Running
echo ========================================
echo Service URL: http://localhost:3002
echo Health check: http://localhost:3002/health
echo.
echo TIP: Press Ctrl+C to stop
echo TIP: Keep this window open
echo ========================================
echo.

REM Start service
"%PYTHON_EXE%" beat_analyzer.py

echo.
echo Service stopped
pause
