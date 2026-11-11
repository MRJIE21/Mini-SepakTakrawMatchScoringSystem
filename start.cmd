@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "STSS_LAUNCHER=1"
set "STSS_DATA_DIR=%~dp0data"
set "STSS_DB=%~dp0data\registry.db"
set "STSS_EVENTS_DIR=%~dp0data\events"
set "STSS_BACKUPS_DIR=%~dp0data\backups"
set "STSS_LOG_DIR=%~dp0data\logs"
set "STSS_LOCK_FILE=%~dp0data\stss.instance.lock"
set "STSS_HOST=0.0.0.0"
set "STSS_PORT=8003"

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
