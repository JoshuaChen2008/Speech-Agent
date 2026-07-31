[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('loopback', 'mic')]
  [string]$Source,

  [ValidateSet(5)]
  [int]$RunCount = 5,

  [string]$OutputDirectory = '.artifacts/i2-live-series',

  [string]$PhysicalMicPreflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}
$projectPrefix = $projectRoot.TrimEnd('\') + '\'
if (-not ($resolvedOutput + '\').StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'I2 series output must stay inside the project workspace.'
}

$preflightPath = $null
if ($Source -eq 'mic') {
  if ([string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
    throw 'PhysicalMicPreflight is required for mic series.'
  }
  $preflightPath = if ([System.IO.Path]::IsPathRooted($PhysicalMicPreflight)) {
    [System.IO.Path]::GetFullPath($PhysicalMicPreflight)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $PhysicalMicPreflight))
  }
  if (-not $preflightPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $preflightPath -PathType Leaf)) {
    throw 'Physical microphone preflight must be an existing report inside the workspace.'
  }
}

New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$summaryPath = Join-Path $resolvedOutput "$Source-series.json"
if (Test-Path -LiteralPath $summaryPath) {
  throw "I2 series summary output already exists; use a fresh output directory."
}
$reportPaths = @()
$exitEvidencePaths = @()
for ($run = 1; $run -le $RunCount; $run += 1) {
  $reportPath = Join-Path $resolvedOutput "$Source-$run.json"
  $exitEvidencePath = Join-Path $resolvedOutput "$Source-$run.exit.json"
  if ((Test-Path -LiteralPath $reportPath) -or (Test-Path -LiteralPath $exitEvidencePath)) {
    throw "I2 run $run output already exists; use a fresh output directory."
  }
  $logDirectory = Join-Path $resolvedOutput "$Source-$run-logs"
  $entryArguments = @('--source', $Source, '--report', $reportPath)
  if ($Source -eq 'mic') {
    $entryArguments += @('--mic-stimulus', 'acoustic-replay', '--physical-mic-preflight', $preflightPath)
  }
  Write-Output "I2 $Source run $run/$RunCount"
  & (Join-Path $PSScriptRoot 'run-electron-smoke.ps1') `
    -EntryPoint 'scripts/i2-live-caption-smoke.js' `
    -EntryArguments $entryArguments `
    -LogDirectory $logDirectory
  $verifyArguments = @($reportPath, $Source)
  if ($Source -eq 'mic') {
    $verifyArguments += @('--gate-0c-report', $preflightPath)
  }
  & node (Join-Path $PSScriptRoot 'verify-i2-live-report.js') @verifyArguments
  if ($LASTEXITCODE -ne 0) { throw "I2 report verification failed for run $run" }
  & node (Join-Path $PSScriptRoot 'write-i2-exact-child-exit.js') `
    --source $Source `
    --report $reportPath `
    --output $exitEvidencePath
  if ($LASTEXITCODE -ne 0) { throw "I2 exact child exit evidence failed for run $run" }
  $reportPaths += $reportPath
  $exitEvidencePaths += $exitEvidencePath
}

if (Test-Path -LiteralPath $summaryPath) {
  throw "I2 series summary output appeared during child runs; refusing to overwrite it."
}
$summaryArguments = @(
  '--output', $summaryPath,
  '--source', $Source,
  '--minimum-runs', $RunCount
)
if ($Source -eq 'mic') {
  $summaryArguments += @('--gate-0c-report', $preflightPath)
}
foreach ($exitEvidencePath in $exitEvidencePaths) {
  $summaryArguments += @('--exit-evidence', $exitEvidencePath)
}
$summaryArguments += $reportPaths
& node (Join-Path $PSScriptRoot 'summarize-i2-live-series.js') @summaryArguments
if ($LASTEXITCODE -ne 0) { throw 'I2 series summary failed.' }
Write-Output "I2 $Source series report: $summaryPath"
