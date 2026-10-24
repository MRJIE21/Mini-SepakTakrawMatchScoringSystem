@echo off
setlocal
chcp 65001 >nul
rem 重定向输出到文件时也强制 UTF-8，避免按系统 locale(GBK) 落盘导致日志乱码
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
set "STSS_LAUNCHER=1"

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto use_python
py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto use_py

echo 未找到可运行的 Python 3.10 或以上版本，请安装 Python 后重新打开。
set "startup_status=1"
goto failed

:use_python
python -u "%~dp0run.py" %*
set "startup_status=%errorlevel%"
goto finished

:use_py
py -3 -u "%~dp0run.py" %*
set "startup_status=%errorlevel%"

:finished
if "%startup_status%"=="0" exit /b 0

:failed
echo.
echo 启动失败，请保留上方错误信息。
pause
exit /b %startup_status%
