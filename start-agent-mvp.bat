@echo off
setlocal

cd /d "%~dp0"
title Speech Agent MVP

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js and try again.
  pause
  exit /b 1
)

call npm.cmd run start:agent-mvp
set "agent_mvp_exit_code=%errorlevel%"

if not "%agent_mvp_exit_code%"=="0" (
  echo.
  echo [ERROR] Agent MVP exited with code %agent_mvp_exit_code%.
  pause
)

exit /b %agent_mvp_exit_code%
