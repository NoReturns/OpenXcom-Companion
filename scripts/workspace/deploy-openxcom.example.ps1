# Deploy verified isolated Win32 Release build to canonical runtime\m0\bin\openxcom.exe
# Template derived from operator runtime/m0/deploy-openxcom.ps1 — configure WorkspaceRoot for your machine.
[CmdletBinding()]
param(
  [string] $WorkspaceRoot = $env:OPENXCOM_COMPANION_WORKSPACE_ROOT
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
} else {
  $WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
}

$Core = Join-Path $WorkspaceRoot 'companion\m0-publish\lib\companion-canonical-runtime.cjs'
if (-not (Test-Path -LiteralPath $Core)) {
  throw "Missing companion runtime module: $Core. Clone OpenXcom-Companion into `$WorkspaceRoot\companion and set -WorkspaceRoot if your layout differs."
}

$layoutJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.companionRuntimeLayout(process.argv[2])));" $Core $WorkspaceRoot
$layout = $layoutJson | ConvertFrom-Json

$running = Get-Process -Name 'openxcom','OpenXcom' -ErrorAction SilentlyContinue
if ($running) {
  throw 'Refusing deploy while OpenXcom is running (stop the game first).'
}

$buildExe = node -e "const m=require(process.argv[1]); const l=m.companionRuntimeLayout(process.argv[2]); console.log(m.resolveBuildReleaseExe(l)||'');" $Core $WorkspaceRoot
if ([string]::IsNullOrWhiteSpace($buildExe) -or -not (Test-Path -LiteralPath $buildExe)) {
  throw "Verified build executable not found under engine\OpenXcom\build-isolated-m1-23e\bin\Release"
}

$buildSha = (Get-FileHash -LiteralPath $buildExe -Algorithm SHA256).Hash.ToLowerInvariant()
# Expected hash is VERIFIED_BUILD_SHA256 in companion\m0-publish\lib\companion-canonical-runtime.cjs
$hashJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.verifyExecutableHashAgainstPin(process.argv[2])));" $Core $buildExe
$hashCheck = $hashJson | ConvertFrom-Json
if (-not $hashCheck.ok) {
  throw "Build SHA-256 mismatch. Got $($hashCheck.runtimeSha256) expected $($hashCheck.expectedSha256). Set VERIFIED_BUILD_SHA256 in companion-canonical-runtime.cjs to this build's hash (then redeploy), or use the build that matches the pin."
}
$buildSha = $hashCheck.runtimeSha256

$dllCheck = node -e "const m=require(process.argv[1]); const l=m.companionRuntimeLayout(process.argv[2]); console.log(JSON.stringify(m.checkRuntimeDllDependencies(l.runtimeBin)));" $Core $WorkspaceRoot
$dll = $dllCheck | ConvertFrom-Json
if (-not $dll.ok) {
  throw "Missing runtime DLL(s) in $($layout.runtimeBin): $($dll.missing -join ', ')"
}

$runtimeExe = $layout.runtimeExe
if (Test-Path -LiteralPath $runtimeExe) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $layout.runtimeBin "openxcom.exe.backup-$stamp"
  Copy-Item -LiteralPath $runtimeExe -Destination $backup -Force
  Write-Host "Rollback copy: $backup"
}

Copy-Item -LiteralPath $buildExe -Destination $runtimeExe -Force
$manifest = node (Join-Path $WorkspaceRoot 'companion\m0-publish\scripts\write-deploy-manifest.cjs') $WorkspaceRoot $buildExe

Write-Host "Deployed canonical executable:"
Write-Host "  Workspace: $WorkspaceRoot"
Write-Host "  Path: $runtimeExe"
Write-Host "  SHA256: $((Get-FileHash -LiteralPath $runtimeExe -Algorithm SHA256).Hash.ToLowerInvariant())"
Write-Host "  Manifest: $($layout.deployManifest)"
Write-Host $manifest
