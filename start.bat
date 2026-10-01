@echo off
rem Start Darkroom on Windows. Double-click this file, or run it from a terminal.
rem Installs dependencies on first run, then serves http://127.0.0.1:4600.
rem Any arguments are passed to `darkroom serve`, e.g. start.bat --port 4700
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Darkroom needs Node.js 20.11 or newer: https://nodejs.org
  goto :fail
)

node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%v in ('node --version') do echo Darkroom needs Node.js 20.11 or newer; found %%v.
  goto :fail
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install --omit=dev
  if errorlevel 1 goto :fail
)

node src\cli.js serve %*
if errorlevel 1 goto :fail
exit /b 0

:fail
pause
exit /b 1
