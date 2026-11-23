@echo off
setlocal EnableExtensions
title Split Finder

for %%I in ("%~dp0..") do set "REPO=%%~fI"
cd /d "%REPO%" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
  echo Run SplitFinder-Setup first, or install Node.js from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo node_modules missing. Run SplitFinder-Setup.bat first.
  pause
  exit /b 1
)

set "EXT=%LOCALAPPDATA%\SplitFinder\chrome-extension"
if not exist "%EXT%\manifest.json" (
  echo Extension not unpacked yet. Run SplitFinder-Setup.bat first.
  pause
  exit /b 1
)

echo Starting local agent dashboard on http://127.0.0.1:8790 ...
start "Split Finder agent" cmd /k "cd /d \"%REPO%\" && npm run agent:dashboard"

timeout /t 2 /nobreak >nul

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" "chrome://extensions/"
) else (
  echo Install Google Chrome, then open chrome://extensions manually.
)

echo.
echo Agent: leave the "Split Finder agent" window open while you use the dashboard.
echo Extension: load unpacked from:
echo   %EXT%
echo.
pause