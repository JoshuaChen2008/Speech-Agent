[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pause-refine', 'worker-crash-retry', 'dwm-drag')]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [ValidateSet('loopback', 'mic')]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [string]$PhysicalMicPreflight,

  [ValidateRange(15, 180)]
  [int]$TimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.artifacts'))
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}
if (-not ($resolvedOutput + '\').StartsWith($artifactRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'I2 interaction output must stay under .artifacts.'
}

$preflightPath = $null
if ($Source -eq 'mic') {
  if ([string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
    throw 'PhysicalMicPreflight is required for controlled mic interaction scenarios.'
  }
  $preflightPath = if ([System.IO.Path]::IsPathRooted($PhysicalMicPreflight)) {
    [System.IO.Path]::GetFullPath($PhysicalMicPreflight)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $PhysicalMicPreflight))
  }
  if (-not ($preflightPath.StartsWith($projectRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or
      -not (Test-Path -LiteralPath $preflightPath -PathType Leaf)) {
    throw 'Physical microphone preflight must be an existing workspace report.'
  }
} elseif (-not [string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
  throw 'PhysicalMicPreflight is only valid when Source is mic.'
}

$reportPath = Join-Path $resolvedOutput "$Scenario-$Source.report.json"
$progressPath = Join-Path $resolvedOutput "$Scenario-$Source.progress.json"
$completionPath = Join-Path $resolvedOutput "$Scenario-$Source.completion.json"
foreach ($pathToCheck in @($reportPath, $progressPath, $completionPath)) {
  if (Test-Path -LiteralPath $pathToCheck) {
    throw "I2 interaction output already exists: $pathToCheck"
  }
}
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

$entryArguments = @('--scenario', $Scenario, '--source', $Source, '--report', $reportPath, '--timeout-seconds', $TimeoutSeconds)
if ($Source -eq 'mic') {
  $entryArguments += @('--physical-mic-preflight', $preflightPath)
}
if ($Scenario -eq 'dwm-drag') {
  $entryArguments += @('--progress', $progressPath, '--completion', $completionPath)
  Write-Output "DWM runner will write ready/completed state to: $progressPath"
  Write-Output "After actual visual drag, record completion with: node scripts/complete-i2-dwm-drag.js --completion $completionPath"
}

& (Join-Path $PSScriptRoot 'run-electron-smoke.ps1') `
  -EntryPoint 'scripts/i2-live-interaction.js' `
  -EntryArguments $entryArguments `
  -LogDirectory (Join-Path $resolvedOutput 'logs') `
  -TimeoutSeconds ([Math]::Min(600, $TimeoutSeconds + 90))

& node (Join-Path $PSScriptRoot 'verify-i2-interaction-report.js') $reportPath $Scenario
if ($LASTEXITCODE -ne 0) { throw 'I2 interaction report verification failed.' }
Write-Output "I2 $Scenario interaction report: $reportPath"
