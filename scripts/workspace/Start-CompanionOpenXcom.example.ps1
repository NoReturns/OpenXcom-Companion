# Canonical OpenXcom Companion launch (game + on-demand relay daemon)
# Template derived from operator runtime/m0/Start-CompanionOpenXcom.ps1
[CmdletBinding()]
param(
  [string] $WorkspaceRoot = $env:OPENXCOM_COMPANION_WORKSPACE_ROOT,
  [switch] $SkipInboxQuarantine,
  [switch] $SkipDeployVerify,
  [switch] $EnableTerrainFullAsciiRelay
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
} else {
  $WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
}

$Core = Join-Path $WorkspaceRoot 'companion\m0-publish\lib\companion-canonical-runtime.cjs'
$Quarantine = Join-Path $WorkspaceRoot 'companion\m0-publish\scripts\quarantine-tactical-inbox.cjs'
$DaemonScript = Join-Path $WorkspaceRoot 'companion\m0-publish\companion-on-demand-relay-daemon.cjs'
$DaemonProcessLib = Join-Path $WorkspaceRoot 'companion\m0-publish\lib\on-demand-daemon-process.cjs'
$PlaySessionLib = Join-Path $WorkspaceRoot 'companion\m0-publish\lib\on-demand-play-session.cjs'

if (-not (Test-Path -LiteralPath $Core)) {
  throw "Missing companion runtime module: $Core"
}

$layoutJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.companionRuntimeLayout(process.argv[2])));" $Core $WorkspaceRoot
$layout = $layoutJson | ConvertFrom-Json

if (-not $SkipInboxQuarantine) {
  if (-not (Test-Path -LiteralPath $Quarantine)) {
    throw "Missing quarantine script: $Quarantine"
  }
  $qOut = node $Quarantine 2>&1 | Out-String
  Write-Host $qOut.Trim()
  if ($LASTEXITCODE -eq 2) {
    throw 'Launch blocked: non-terminal tactical-result.json (resolve before starting the game).'
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Inbox quarantine script failed (exit $LASTEXITCODE)"
  }
}

$runtimeExe = $layout.runtimeExe
if (-not (Test-Path -LiteralPath $runtimeExe)) {
  throw "Canonical executable missing. Run: companion\scripts\workspace\deploy-openxcom.example.ps1 -WorkspaceRoot `"$WorkspaceRoot`""
}

$runtimeSha = (Get-FileHash -LiteralPath $runtimeExe -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedSha = node -e "console.log(require(process.argv[1]).VERIFIED_BUILD_SHA256)" $Core
if (-not $SkipDeployVerify -and $runtimeSha -ne $expectedSha) {
  throw "Runtime SHA-256 mismatch. Expected $expectedSha got $runtimeSha. Align companion-canonical-runtime.cjs with this binary or run deploy-openxcom.example.ps1 for the build matching the pin."
}

$manifestSha = $null
if (Test-Path -LiteralPath $layout.deployManifest) {
  try {
    $manifestSha = (Get-Content -LiteralPath $layout.deployManifest -Raw | ConvertFrom-Json).sha256
  } catch {
    Write-Warning "Could not read deploy manifest at $($layout.deployManifest)"
  }
}

$RelayLocalConfig = Join-Path $WorkspaceRoot 'companion\m0-publish\config\relay.local.json'
if (-not $env:OPENXCOM_COMPANION_RELAY_REPO -and (Test-Path -LiteralPath $RelayLocalConfig)) {
  try {
    $relayCfg = Get-Content -LiteralPath $RelayLocalConfig -Raw | ConvertFrom-Json
    if ($relayCfg.repo) {
      $env:OPENXCOM_COMPANION_RELAY_REPO = [string]$relayCfg.repo
    }
    if (-not $env:OPENXCOM_COMPANION_RELAY_BRANCH -and $relayCfg.branch) {
      $env:OPENXCOM_COMPANION_RELAY_BRANCH = [string]$relayCfg.branch
    }
    Write-Host "Relay destination loaded from relay.local.json"
  } catch {
    Write-Warning "Could not parse relay.local.json — set OPENXCOM_COMPANION_RELAY_REPO manually."
  }
}

$env:OPENXCOM_COMPANION_SNAPSHOT_PATH = $layout.snapshotYaml
$env:OPENXCOM_COMPANION_COMMAND_EXECUTOR = '1'
if ($EnableTerrainFullAsciiRelay) {
  $env:OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII = '1'
} else {
  Remove-Item Env:OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII -ErrorAction SilentlyContinue
}
$EnsureDaemonScript = Join-Path $WorkspaceRoot 'companion\m0-publish\scripts\ensure-on-demand-daemon.cjs'
$env:OPENXCOM_COMPANION_ENSURE_DAEMON_SCRIPT = $EnsureDaemonScript
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $env:OPENXCOM_COMPANION_NODE_EXE = $nodeCmd.Source
}

function Stop-CompanionLegacyWatchers {
  $legacyJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.findLegacyContinuousWatchers()));" $DaemonProcessLib
  $legacy = @($legacyJson | ConvertFrom-Json)
  if ($legacy.Count -gt 0) {
    Write-Host "Stopping legacy continuous relay sidecars (M1-25E on-demand mode)."
    foreach ($proc in $legacy) {
      node -e "require(process.argv[1]).stopProcessTree(Number(process.argv[2]));" $DaemonProcessLib $proc.pid | Out-Null
    }
  }
}

function Stop-CompanionPlaySession {
  param(
    [string] $SnapshotPath,
    [string] $SessionId,
    [int] $LauncherPid
  )
  $out = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.shutdownCompanionPlaySession({ snapshotPath: process.argv[2], sessionId: process.argv[3], launcherPid: Number(process.argv[4]) })));" $PlaySessionLib $SnapshotPath $SessionId $LauncherPid 2>&1 | Out-String
  Write-Host $out.Trim()
  try {
    $result = $out.Trim() | ConvertFrom-Json
    if (-not $result.ok) {
      Write-Warning "Companion play session shutdown reported: $($result.error) (code $($result.code))"
    }
  } catch {
    Write-Warning 'Could not parse play session shutdown JSON.'
  }
}

function Start-CompanionOnDemandDaemon {
  param([string] $SnapshotPath)
  $startJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.startOnDemandDaemonVerified({ snapshotPath: process.argv[2], daemonScript: process.argv[3], cwd: process.argv[4], timeoutMs: m.CANONICAL_STARTUP_TIMEOUT_MS })));" $DaemonProcessLib $SnapshotPath $DaemonScript (Split-Path -Parent $DaemonScript)
  $start = $startJson | ConvertFrom-Json
  if (-not $start.ok) {
    throw "On-demand relay daemon failed to start: $($start.error)"
  }
  $HealthLib = Join-Path $WorkspaceRoot 'companion\m0-publish\lib\on-demand-daemon-health.cjs'
  $verify = $null
  $verifyDeadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $verifyDeadline) {
    $verifyJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.verifyDaemonStartupLive(process.argv[2], Number(process.argv[3]))));" $HealthLib $SnapshotPath $start.pid
    $verify = $verifyJson | ConvertFrom-Json
    if ($verify.ok) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $verify.ok) {
    node -e "const m=require(process.argv[1]); m.recordStartupVerificationFailure(process.argv[2], Number(process.argv[3]), {}, { source: process.argv[4], failed_predicate: process.argv[5] });" $HealthLib $SnapshotPath $start.pid 'powershell_launcher' $verify.reason | Out-Null
    Write-Host "  Startup verify diagnostics recorded (predicate: $($verify.reason))."
    throw "On-demand relay daemon failed live verification: $($verify.reason)"
  }
  Write-Host "  Daemon verify: pid $($verify.pid) state $($verify.health.state)"
  return @{ Pid = [int]$start.pid; StartedByUs = [bool]$start.startedByUs; StartupVerified = $true; Verify = $verify }
}

Stop-CompanionLegacyWatchers

$playSessionId = $null
$playSessionShutdownNeeded = $false
try {
  $sessionJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.beginCompanionPlaySession({ snapshotPath: process.argv[2], launcherPid: Number(process.argv[3]) })));" $PlaySessionLib $layout.snapshotYaml $PID
  $playSession = $sessionJson | ConvertFrom-Json
  if (-not $playSession.ok) {
    throw "Companion play session could not start: $($playSession.error)"
  }
  $playSessionId = $playSession.sessionId
  $playSessionShutdownNeeded = $true

  $daemonInfo = Start-CompanionOnDemandDaemon -SnapshotPath $layout.snapshotYaml
  $daemonPid = $daemonInfo.Pid
  $daemonStartedByUs = $daemonInfo.StartedByUs
  node -e "const m=require(process.argv[1]); m.registerPlaySessionDaemonPid(process.argv[2], process.argv[3], Number(process.argv[4]));" $PlaySessionLib $layout.snapshotYaml $playSessionId $daemonPid | Out-Null

  Write-Host 'Companion canonical launch (on-demand relay)'
  Write-Host "  Workspace:  $WorkspaceRoot"
  Write-Host "  Executable: $runtimeExe"
  Write-Host "  SHA256:     $runtimeSha"
  if ($manifestSha) {
    Write-Host "  Manifest:   $manifestSha"
  }
  Write-Host "  Data:       $($layout.runtimeBin)"
  Write-Host "  User:       $($layout.userDir)"
  Write-Host "  Snapshot:   $($layout.snapshotYaml)"
  Write-Host "  EXECUTOR:   $env:OPENXCOM_COMPANION_COMMAND_EXECUTOR"
  Write-Host "  ASCII relay: $(if ($env:OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII -eq '1') { 'ON (OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII=1)' } else { 'off' })"
  Write-Host "  Daemon:     pid $daemonPid (started_by_launcher=$daemonStartedByUs; session-scoped shutdown)"
  Write-Host "  Session:    $playSessionId"

  $gameArgs = "-data `"$($layout.runtimeBin)`" -user `"$($layout.userDir)`" -config `"$($layout.userDir)`""
  $gameProc = Start-Process -FilePath $runtimeExe -WorkingDirectory $layout.runtimeBin -ArgumentList $gameArgs -PassThru
  Write-Host "OpenXcom started (pid $($gameProc.Id))."
  node -e "const m=require(process.argv[1]); m.registerPlaySessionGamePid(process.argv[2], process.argv[3], Number(process.argv[4]));" $PlaySessionLib $layout.snapshotYaml $playSessionId $gameProc.Id | Out-Null
  Wait-Process -Id $gameProc.Id
} catch {
  if ($playSessionShutdownNeeded -and $playSessionId) {
    $failJson = node -e "const m=require(process.argv[1]); console.log(JSON.stringify(m.reconcilePlaySessionLeaseAfterFailedDaemonStart({ snapshotPath: process.argv[2], sessionId: process.argv[3], launcherPid: Number(process.argv[4]) })));" $PlaySessionLib $layout.snapshotYaml $playSessionId $PID
    Write-Host $failJson.Trim()
  }
  throw
} finally {
  if ($playSessionShutdownNeeded -and $playSessionId) {
    Write-Host 'Shutting down companion play session (verified daemons for this snapshot).'
    Stop-CompanionPlaySession -SnapshotPath $layout.snapshotYaml -SessionId $playSessionId -LauncherPid $PID
  }
}
