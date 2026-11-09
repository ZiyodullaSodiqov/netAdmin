@echo off
REM Windows: ikki marta bosib ishga tushiring. Yiqilsa 10 soniyadan keyin qayta ishga tushadi.
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
:loop
.venv\Scripts\python -m yordamchi
echo Qayta ishga tushirilmoqda...
timeout /t 10 >nul
goto loop
