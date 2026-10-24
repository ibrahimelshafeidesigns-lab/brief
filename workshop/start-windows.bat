@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist .env (
  echo Copy .env.example to .env and fill in the key and PINs first.
  pause
  exit /b 1
)
:loop
node --env-file=.env server.js
echo The app stopped. Starting again in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
