param([switch]$ProbeLaunch)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$resourceRoot = Join-Path $PSScriptRoot '../dist-cua-helper/windows-x64'
$helperPath = [IO.Path]::GetFullPath((Join-Path $resourceRoot 'fcode-cua-helper.exe'))
$manifestPath = Join-Path $resourceRoot 'capability.json'
$report = [ordered]@{
    schemaVersion = 1
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    productAcceptance = $false
    securityPolicyChanged = $false
    probeRequested = [bool]$ProbeLaunch
}
$missing = @()
$blocked = $false

if ($env:OS -ne 'Windows_NT') {
    Write-Output '{"error":"windows_required","productAcceptance":false}'
    exit 1
}

$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$report.os = [ordered]@{
    displayVersion = $version.DisplayVersion
    build = [int]$version.CurrentBuild
    revision = [int]$version.UBR
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$report.administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$policy = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
$report.smartAppControlState = $policy.VerifiedAndReputablePolicyState
try {
    $defender = Get-MpComputerStatus
    $report.defender = [ordered]@{
        antivirusEnabled = $defender.AntivirusEnabled
        realTimeProtectionEnabled = $defender.RealTimeProtectionEnabled
        tamperProtectionEnabled = $defender.IsTamperProtected
    }
} catch { $report.defender = @{ error = 'status_unavailable' } }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = $null
if (Test-Path -LiteralPath $vswhere) {
    $installation = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if ($installation) {
    $cmake = Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
    $toolsetFile = Join-Path $installation 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'
    $report.toolchain = [ordered]@{
        msvcToolset = if (Test-Path -LiteralPath $toolsetFile) { (Get-Content -LiteralPath $toolsetFile -Raw).Trim() } else { $null }
        cmakePresent = Test-Path -LiteralPath $cmake
    }
    if (-not $report.toolchain.msvcToolset) { $missing += 'msvc_toolset_missing' }
    if (-not $report.toolchain.cmakePresent) { $missing += 'cmake_missing' }
} else { $missing += 'visual_studio_build_tools_missing' }

$helperValid = $false
if ((Test-Path -LiteralPath $helperPath) -and (Test-Path -LiteralPath $manifestPath)) {
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 65536) {
        $missing += 'manifest_oversized'
    } else {
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $helperHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $signature = Get-AuthenticodeSignature -LiteralPath $helperPath
            $helperValid = $manifest.schemaVersion -eq 1 -and $manifest.platform -eq 'win32' -and
                $manifest.arch -eq 'x64' -and $manifest.nativeProtocolVersion -eq 1 -and
                $manifest.executableName -eq 'fcode-cua-helper.exe' -and $helperHash -ceq $manifest.helperSha256
            $report.helper = [ordered]@{
                matchesBuildManifest = $helperValid
                authenticodeStatus = $signature.Status.ToString()
                productAvailable = [bool]$manifest.available
                reason = 'prototype_only'
            }
            if (-not $helperValid) { $missing += 'helper_manifest_mismatch' }
        } catch { $missing += 'helper_metadata_invalid' }
    }
} else { $missing += 'built_helper_missing' }

if ($ProbeLaunch -and $helperValid) {
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = [Diagnostics.ProcessStartInfo]::new($helperPath)
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $started = $false
    try {
        $started = $process.Start()
        $process.StandardInput.Close()
        $finished = $process.WaitForExit(3000)
        $report.launch = [ordered]@{
            processCreated = $started
            exitedWithinDeadline = $finished
            sessionAuthenticated = $false
        }
        if ($finished) { $report.launch.exitCode = $process.ExitCode }
        # Closing stdin tests process creation only, not the native hello protocol.
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $nativeCode = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $null }
        $blocked = $true
        $report.launch = [ordered]@{
            processCreated = $false
            nativeErrorCode = $nativeCode
            error = if ($nativeCode -eq 4551) { 'application_control_blocked' } else { 'process_creation_failed' }
            sessionAuthenticated = $false
        }
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            [void]$process.WaitForExit(1000)
        }
        $process.Dispose()
    }
}

$report.missing = $missing
$report.result = if ($blocked) { 'launch_blocked' } elseif ($missing.Count) { 'prerequisites_missing' } elseif (-not $ProbeLaunch) { 'inspection_only' } else { 'process_creation_allowed' }
$artifactRoot = Join-Path $workspaceRoot '.tmp/windows-cua'
[void][IO.Directory]::CreateDirectory($artifactRoot)
$json = $report | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $artifactRoot 'environment.json'), $json, [Text.UTF8Encoding]::new($false))
Write-Output $json
if ($blocked) { exit 2 }
if ($missing.Count) { exit 1 }
exit 0
