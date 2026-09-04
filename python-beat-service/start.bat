@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 > nul

echo ========================================
echo Beat Analysis Service - Startup
echo ========================================
echo.

set "SERVICE_DIR=%~dp0"
set "PYTHON_EXE=%SERVICE_DIR%..\resources\python-embed\python.exe"
set "BUNDLED_MODEL=%SERVICE_DIR%..\resources\beat-this\final0.ckpt"
set "EXPECTED_MODEL_SHA256=8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"

if not exist "%PYTHON_EXE%" (
    echo ERROR: Built-in Python not found at %PYTHON_EXE%
    exit /b 1
)

if not defined BEAT_THIS_CHECKPOINT set "BEAT_THIS_CHECKPOINT=%BUNDLED_MODEL%"
if not defined WAVEFORGE_BEAT_MODEL_PATH set "WAVEFORGE_BEAT_MODEL_PATH=%BEAT_THIS_CHECKPOINT%"

"%PYTHON_EXE%" --version

echo [1/3] Checking required runtime...
"%PYTHON_EXE%" -c "import beat_this, torch, torchaudio, einops, rotary_embedding_torch, soxr"
if errorlevel 1 (
    echo ERROR: Required Beat This runtime dependencies are missing.
    echo Rebuild the embedded runtime with npm run bundle-python.
    exit /b 1
)

echo [2/3] Checking Beat This model...
if not exist "%BEAT_THIS_CHECKPOINT%" (
    echo ERROR: Required Beat This final0 model is missing.
    exit /b 1
)
set "ACTUAL_SHA256="
for /f "skip=1 tokens=1" %%H in ('certutil -hashfile "%BEAT_THIS_CHECKPOINT%" SHA256 ^| findstr /r /v "certutil"') do if not defined ACTUAL_SHA256 set "ACTUAL_SHA256=%%H"
if /i not "%ACTUAL_SHA256%"=="%EXPECTED_MODEL_SHA256%" (
    echo ERROR: Beat This final0 SHA-256 mismatch. Refusing to start.
    exit /b 1
)
echo Model verified: %BEAT_THIS_CHECKPOINT%
echo.

echo [3/3] Starting service...
echo Service URL: http://localhost:3002
echo Health check: http://localhost:3002/health
echo.
"%PYTHON_EXE%" "%SERVICE_DIR%beat_analyzer.py"
exit /b %errorlevel%
