@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python topilmadi. https://www.python.org/downloads/ dan o'rnating ^("Add Python to PATH"^). & pause & exit /b 1)
python start.py %*
pause
