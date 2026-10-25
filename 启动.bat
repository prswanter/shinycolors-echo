@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   闪耀色彩复读机 —— 29 种复读模式
echo.
python server.py --open
pause
