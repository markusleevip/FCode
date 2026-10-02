@echo off
rem Shared Windows environment setup for build.cmd, run.cmd and package.cmd.
rem Usage: call "%~dp0scripts\windows-env.cmd"   (the caller must run setlocal first)
rem
rem Toolchain lookup, in order:
rem   1. FCODE_TOOLCHAIN: an environment variable, or set in an untracked toolchain.local.cmd
rem      next to build.cmd. It must point at a root that contains
rem      node24\node-v24.14.0-win-x64 and pnpm\node_modules\.bin.
rem   2. node and pnpm found on PATH (Node.js 24.x and pnpm 10.x). If node is on PATH but pnpm
rem      is not, pnpm is enabled through corepack (bundled with Node.js 24), which needs network
rem      access the first time to download the pnpm version pinned in package.json.
set "REQUIRED_NODE_MAJOR=24"
set "REQUIRED_PNPM_MAJOR=10"
set "ENV_DIR=%~dp0"

if exist "%~dp0..\toolchain.local.cmd" call "%~dp0..\toolchain.local.cmd"

if defined FCODE_TOOLCHAIN goto toolchain
goto fromPath

:toolchain
set "NODE_DIR=%FCODE_TOOLCHAIN%\node24\node-v24.14.0-win-x64"
set "PNPM_CMD=%FCODE_TOOLCHAIN%\pnpm\node_modules\.bin\pnpm.cmd"
if not exist "%NODE_DIR%\node.exe" (
  echo [ERROR] Node.js 24.14.0 not found: "%NODE_DIR%\node.exe"
  exit /b 1
)
if not exist "%PNPM_CMD%" (
  echo [ERROR] pnpm 10.33.2 not found: "%PNPM_CMD%"
  exit /b 1
)
set "NODE_EXE=%NODE_DIR%\node.exe"
set "PATH=%NODE_DIR%;%FCODE_TOOLCHAIN%\pnpm\node_modules\.bin;%PATH%"
goto done

:fromPath
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js %REQUIRED_NODE_MAJOR%.x and add it to PATH, or set FCODE_TOOLCHAIN.
  echo         Alternatively set FCODE_TOOLCHAIN, either as an environment variable or in apps\desktop\toolchain.local.cmd ^(untracked, machine-local^).
  exit /b 1
)
where pnpm >nul 2>&1
if errorlevel 1 call :enableCorepackPnpm
if errorlevel 1 exit /b 1
for /f "usebackq" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set "NODE_MAJOR=%%v"
if not "%NODE_MAJOR%"=="%REQUIRED_NODE_MAJOR%" (
  echo [ERROR] Node.js major version must be %REQUIRED_NODE_MAJOR%, found %NODE_MAJOR%.
  echo         Install Node.js %REQUIRED_NODE_MAJOR%.x and put it first on PATH, or set FCODE_TOOLCHAIN, either as an environment variable or in apps\desktop\toolchain.local.cmd ^(untracked, machine-local^).
  exit /b 1
)
for /f "usebackq tokens=1 delims=." %%v in (`pnpm --version`) do set "PNPM_MAJOR=%%v"
if not "%PNPM_MAJOR%"=="%REQUIRED_PNPM_MAJOR%" (
  echo [ERROR] pnpm major version must be %REQUIRED_PNPM_MAJOR%, found %PNPM_MAJOR%.
  echo         Install pnpm %REQUIRED_PNPM_MAJOR%.x, or set FCODE_TOOLCHAIN, either as an environment variable or in apps\desktop\toolchain.local.cmd ^(untracked, machine-local^).
  exit /b 1
)
set "NODE_EXE=node"
set "PNPM_CMD=pnpm"

:done
if not defined FCODE_PNPM_VIA_COREPACK set "COREPACK_ENABLE_PROJECT_SPEC=0"
set "FCODE_SKIP_REMOTE_ASSETS=1"
exit /b 0

rem pnpm is not installed: expose it through corepack. The launchers live in a git-ignored folder
rem inside the project and are put on PATH, so nested "pnpm" calls made by package scripts work too.
rem The project spec stays enabled so corepack picks the pnpm version pinned in package.json.
:enableCorepackPnpm
where corepack >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm not found and corepack is unavailable. Install pnpm %REQUIRED_PNPM_MAJOR%.x and add it to PATH,
  echo         or set FCODE_TOOLCHAIN, either as an environment variable or in apps\desktop\toolchain.local.cmd ^(untracked, machine-local^).
  exit /b 1
)
set "COREPACK_SHIM_DIR=%ENV_DIR%..\.tmp\corepack-shims"
if not exist "%COREPACK_SHIM_DIR%" mkdir "%COREPACK_SHIM_DIR%"
if not exist "%COREPACK_SHIM_DIR%\pnpm.cmd" (
  echo [INFO] pnpm not found on PATH; enabling it through corepack...
  call corepack enable --install-directory "%COREPACK_SHIM_DIR%" pnpm
  if errorlevel 1 (
    echo [ERROR] corepack could not enable pnpm. Install pnpm %REQUIRED_PNPM_MAJOR%.x and add it to PATH.
    exit /b 1
  )
)
set "PATH=%COREPACK_SHIM_DIR%;%PATH%"
set "COREPACK_ENABLE_PROJECT_SPEC=1"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
set "FCODE_PNPM_VIA_COREPACK=1"
exit /b 0
