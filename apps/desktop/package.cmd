@echo off
setlocal
cd /d "%~dp0"

set "OVERWRITE="
:parseArgs
if "%~1"=="" goto configured
if /i "%~1"=="x64" (
  shift
  goto parseArgs
)
if /i "%~1"=="--overwrite" (
  set "OVERWRITE=--overwrite"
  shift
  goto parseArgs
)
:usage
echo [ERROR] Usage: package.cmd [x64] [--overwrite] - local Windows releases support x64 only.
exit /b 1

:configured
call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 exit /b 1

call "%NODE_EXE%" --version
if errorlevel 1 exit /b %errorlevel%
call "%PNPM_CMD%" --version
if errorlevel 1 exit /b %errorlevel%

if not exist "node_modules\typescript\bin\tsc" (
  echo [INFO] Installing workspace dependencies...
  call "%PNPM_CMD%" install --frozen-lockfile
  if errorlevel 1 exit /b 1
)

echo [INFO] Packaging Windows x64 installer...
call "%NODE_EXE%" scripts/stage-desktop-release.mjs --os win --arch x64 %OVERWRITE%
exit /b %errorlevel%
