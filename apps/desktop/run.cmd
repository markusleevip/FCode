@echo off
setlocal
cd /d "%~dp0"

call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 exit /b 1
set "FCODE_DATA_BASE_DIR=%~dp0.felixcode-local-data"
set "FCODE_DATA_DIR_NAME=.fcode"
set "FCODE_DESKTOP_HOME_DIR=%FCODE_DATA_BASE_DIR%"

call "%NODE_EXE%" "%~dp0scripts\prepare-isolated-desktop-data.mjs"
if errorlevel 1 exit /b 1

if not exist "node_modules\typescript\bin\tsc" (
  echo [ERROR] Dependencies are missing. Run build.cmd first.
  exit /b 1
)

call "%PNPM_CMD%" dev:desktop:test
exit /b %errorlevel%
