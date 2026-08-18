@echo off
chcp 65001 >nul
echo ========================================
echo WaveForge Python 依赖安装脚本
echo ========================================
echo.

set PYTHON_EXE=resources\python-embed\python.exe
set PIP_EXE=resources\python-embed\Scripts\pip.exe

REM 检查内嵌 Python 是否存在
echo [1/3] 检查项目内嵌 Python 环境...
if not exist "%PYTHON_EXE%" (
    echo [错误] 未检测到项目内嵌的 Python！
    echo.
    echo 请确保 resources\python-embed\python.exe 存在
    pause
    exit /b 1
)

echo [成功] 项目内嵌 Python 已就绪
"%PYTHON_EXE%" --version
echo.

REM 安装依赖
echo [2/3] 安装 Python 依赖包...
echo 使用清华大学镜像源加速下载...
echo.
"%PIP_EXE%" install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

if %errorlevel% neq 0 (
    echo.
    echo [错误] 依赖安装失败！
    pause
    exit /b 1
)

echo.
echo [3/3] 验证安装...
"%PYTHON_EXE%" -c "import pedalboard; import numpy; import scipy; print('所有依赖安装成功！')"

if %errorlevel% neq 0 (
    echo [错误] 依赖验证失败！
    pause
    exit /b 1
)

echo.
echo ========================================
echo 安装完成！现在可以运行 WaveForge 了
echo 使用命令: npm run dev:electron
echo ========================================
echo.
pause
