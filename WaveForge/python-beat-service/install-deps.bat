@echo off
chcp 65001 > nul
echo ========================================
echo Install Python Dependencies
echo ========================================
echo.

set PYTHON_EXE=..\resources\python-embed\python.exe
set PIP_EXE=..\resources\python-embed\Scripts\pip.exe

if not exist "%PYTHON_EXE%" (
    echo ERROR: Python not found
    echo.
    pause
    exit /b 1
)

echo Using Python:
"%PYTHON_EXE%" --version
echo.

echo Choose installation method:
echo [1] Install from local packages (fastest, no internet needed)
echo [2] Install from official PyPI (may be slow)
echo [3] Install from Tsinghua mirror (faster in China)
echo.
choice /c 123 /n /m "Select (1, 2 or 3): "

if errorlevel 3 (
    echo.
    echo Installing from Tsinghua mirror...
    "%PIP_EXE%" install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
) else if errorlevel 2 (
    echo.
    echo Installing from official PyPI...
    "%PIP_EXE%" install -r requirements.txt
) else (
    echo.
    echo Installing from local packages...
    "%PIP_EXE%" install --no-index --find-links=packages -r requirements.txt
)

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo Dependencies installed successfully!
    echo ========================================
    echo.
    echo You can now run: start.bat
) else (
    echo.
    echo ========================================
    echo Installation failed
    echo ========================================
    echo Please check your network connection
)

echo.
pause
