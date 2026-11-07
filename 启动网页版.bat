@echo off
rem 启动网页版（带本地后端）：rar/cbr、PDF、磁盘路径、与桌面版共享进度都可用
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 没找到 python。请先装 Python 3，或直接用桌面版 图片漫画浏览器.exe
  pause
  exit /b 1
)
python -u web_backend.py
