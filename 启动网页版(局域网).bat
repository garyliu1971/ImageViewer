@echo off
rem 启动网页版（局域网）：手机/VLC 同 Wi-Fi 可访问
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 没找到 python。请先装 Python 3。
  pause
  exit /b 1
)
python -u web_backend.py --lan
pause
