@echo off
REM One-time setup: install dependencies, Playwright browsers, then start server.
cd /d %~dp0

echo Installing npm dependencies...
npm install
if %ERRORLEVEL% NEQ 0 (
  echo npm install failed. Fix errors and re-run this script.
  pause
  exit /b 1
)

echo Installing Playwright browser binaries (this may take a few minutes)...
npx playwright install
if %ERRORLEVEL% NEQ 0 (
  echo playwright install failed. Fix errors and re-run this script.
  pause
  exit /b 1
)

echo Setup complete. Starting server...
start "WTS Connector" cmd /k "cd /d %~dp0 && echo Running: npm start && npm start"
exit /b 0