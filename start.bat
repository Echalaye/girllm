@echo off
rem girllm one-click launcher: starts Ollama, ComfyUI (if configured) and girllm,
rem then opens the browser. Ctrl+C stops everything this script started.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist .env copy .env.example .env >nul

call npm.cmd run -s launch -- %*
if errorlevel 1 pause
