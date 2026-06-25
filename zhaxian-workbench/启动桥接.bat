@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动谪仙剧本工作台桥接...
python bridge.py
if errorlevel 1 (
  echo.
  echo 启动失败：可能没装 Python。请到 https://www.python.org 下载安装，
  echo 安装时记得勾选「Add Python to PATH」，然后再双击本文件。
  pause
)
