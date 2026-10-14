@echo off
rem girllm installer for Windows: double-click it from the girllm folder.
rem It installs what is missing (Node.js, Git, Ollama, ComfyUI, models), fills
rem in .env and creates a desktop shortcut. Safe to run again: finished steps
rem are skipped. Details: docs\installation.md. Log: data\logs\install.log.
rem
rem   install.bat -Defaults                     no questions, recommended choices
rem   install.bat -ComfyUIDir "D:\ComfyUI_windows_portable"   use your ComfyUI
setlocal
cd /d "%~dp0"
rem -ExecutionPolicy Bypass applies to this run only; nothing is changed system-wide.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install\install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
