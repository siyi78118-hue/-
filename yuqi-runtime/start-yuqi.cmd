@echo off
setlocal
cd /d "%~dp0"
node src\main.mjs config.json
endlocal
