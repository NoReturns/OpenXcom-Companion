# Open X-Com Companion — unified relay launcher (M1-22B1)
# Default: read-only preflight. Does not modify local/m0 runtime files.

[CmdletBinding()]
param(
  [switch] $StartOutbound,
  [switch] $StartFull,
  [switch] $AcknowledgeInboundRisk,
  [switch] $DryRun,
  [switch] $Json,
  [string] $SnapshotPath = $env:OPENXCOM_COMPANION_SNAPSHOT_PATH
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $ScriptDir 'companion-relay-launcher-cli.cjs'

if (-not (Test-Path -LiteralPath $Cli)) {
  Write-Error "Missing launcher CLI: $Cli"
}

$nodeArgs = @()

if ($SnapshotPath) {
  if (-not (Test-Path -LiteralPath $SnapshotPath)) {
    Write-Error "Snapshot path not found: $SnapshotPath"
  }
  $nodeArgs += @('--snapshot-path', (Resolve-Path -LiteralPath $SnapshotPath).Path)
}

if ($StartOutbound -and $StartFull) {
  Write-Error 'Use either -StartOutbound or -StartFull, not both.'
}

if (-not $StartOutbound -and -not $StartFull) {
  if ($Json) { $nodeArgs += '--json' }
  $nodeArgs += '--preflight'
  & node $Cli @nodeArgs
  exit $LASTEXITCODE
}

if ($DryRun) { $nodeArgs += '--dry-run' }

if ($StartOutbound) {
  $nodeArgs += @('--start', 'outbound')
  & node $Cli @nodeArgs
  exit $LASTEXITCODE
}

if ($StartFull) {
  if ($AcknowledgeInboundRisk) {
    $nodeArgs += '--acknowledge-inbound-risk'
  }
  $nodeArgs += @('--start', 'full')
  & node $Cli @nodeArgs
  exit $LASTEXITCODE
}
