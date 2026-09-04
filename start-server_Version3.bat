@echo off
REM Start server in new command window. Place this file in project root.
cd /d %~dp0

REM Check .env exists
if not exist ".env" (
  echo ERROR: .env not found in %~dp0
  echo Please create .env (copy from .env.example) then retry.
  pause
  exit /b 1
)

echo Starting WTS Connector...
REM Opens new cmd window and runs npm start, leaving window open for logs
start "WTS Connector" cmd /k "cd /d %~dp0 && echo Running: npm start && npm start"
exit /b 0