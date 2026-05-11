@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 20+ first.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo node_modules not found. Installing npm dependencies...
  call npm ci
  if errorlevel 1 (
    echo.
    echo npm ci failed.
    pause
    exit /b 1
  )
)

echo Starting LLM Wiki in Tauri development mode...
echo.
call npm run tauri dev
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo LLM Wiki exited with error code %EXIT_CODE%.
) else (
  echo LLM Wiki exited.
)
pause
exit /b %EXIT_CODE%
