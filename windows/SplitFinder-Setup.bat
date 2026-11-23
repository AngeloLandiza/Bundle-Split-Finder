@echo off
setlocal EnableExtensions
title Split Finder setup

for %%I in ("%~dp0..") do set "REPO=%%~fI"
cd /d "%REPO%" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install LTS from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

echo Repo: %REPO%
echo.
echo Installing npm dependencies ^(first time may take a few minutes^)...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env from .env.example — paste SERPAPI_API_KEY in a text editor when you are ready.
  )
)

echo.
echo Building the Chrome extension zip...
call npm run package
if errorlevel 1 (
  echo npm run package failed.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0extract-extension.ps1" -RepoRoot "%REPO%"
if errorlevel 1 (
  echo Could not unpack the extension.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0write-shortcuts.ps1" -RepoRoot "%REPO%"

echo.
echo Setup complete.
echo   Extension folder: %LOCALAPPDATA%\SplitFinder\chrome-extension
echo   1. Open Chrome, go to chrome://extensions
echo   2. Turn on Developer mode
echo   3. Load unpacked, choose that folder
echo.
echo Double-click SplitFinder-Start ^(bat or vbs^) to run the local agent dashboard.
pause