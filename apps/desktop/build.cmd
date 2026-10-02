@echo off
setlocal
cd /d "%~dp0"

set "RELEASE=0"
if not "%~2"=="" goto usage
if "%~1"=="" goto configured
if /i "%~1"=="--release" (
  set "RELEASE=1"
  goto configured
)
:usage
echo [ERROR] Usage: build.cmd [--release]
exit /b 1

:configured
if exist ".tmp\desktop-release.lock\" (
  echo [ERROR] A desktop release is active. Wait for it to finish before compiling.
  exit /b 1
)
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

call "%PNPM_CMD%" run build:bootstrap
if errorlevel 1 exit /b %errorlevel%
if "%RELEASE%"=="1" call "%~dp0package.cmd"
exit /b %errorlevel%
