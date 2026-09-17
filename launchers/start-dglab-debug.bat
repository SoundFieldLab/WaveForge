@echo off
setlocal
chcp 65001 > nul
REM This script lives in launchers/, so the project root is one level up.
REM NOTE: keep REM comments ASCII-only. Under chcp 65001, CJK text (especially with
REM quotes) inside REM lines can desync cmd.exe parsing and get run as commands.
set "PROJECT_ROOT=%~dp0..\"
pushd "%PROJECT_ROOT%" >nul

echo ========================================
echo WaveForge - DG-LAB 调试平台（真机测试）
echo ========================================
echo.
echo 前端 3100 / API 3101 / 中继 31082
echo （与主程序 3000/3001/30082 错开，可同时运行）
echo.

REM The platform needs vite/express/ws/qrcode from node_modules.
if not exist "%PROJECT_ROOT%node_modules" (
    echo [错误] 未找到 node_modules，请先在项目根目录执行 npm install
    popd >nul
    pause
    exit /b 1
)

echo 启动调试后端与前端...
echo 启动后用手机 DG-Lab App 扫控制台里的二维码（手机需与电脑同一 WiFi）
echo.
start "DG-LAB Debug Platform" cmd /k "chcp 65001 >nul && cd /d ""%PROJECT_ROOT%"" && npm run dglab:debug:all"

popd >nul
echo 已在新窗口启动。浏览器打开 http://127.0.0.1:3100
REM Absolute path avoids Git Bash coreutils timeout shadowing Windows timeout.exe.
REM stderr discarded: timeout complains when stdin is redirected (harmless noise).
"%SystemRoot%System32	imeout.exe" /t 5 /nobreak > nul 2>&1
