@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 图片漫画浏览器 一键打包
echo ============================================
echo   图片漫画浏览器 一键打包（安装程序 + 便携版）
echo ============================================
echo.
python build_installer.py %*
echo.
echo 打包结束。产物在「发布」目录，可拷贝到 U 盘分发。
pause
