[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pause-refine', 'worker-crash-retry', 'dwm-drag', 'device-removal-retry', 'sleep-wake-retry')]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [ValidateSet('loopback', 'mic')]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [string]$PhysicalMicPreflight,

  [int]$ScalePercent = 0,

  [string]$Theme,

  [int]$CrossScaleFromPercent = 0,

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

$supportedScales = @(100, 125, 150, 200)
$supportedThemes = @('dark', 'light', 'high-contrast')
if ($Scenario -eq 'dwm-drag') {
  if ($ScalePercent -notin $supportedScales -or $Theme -notin $supportedThemes) {
    throw 'dwm-drag requires ScalePercent=100|125|150|200 and Theme=dark|light|high-contrast.'
  }
  if ($CrossScaleFromPercent -ne 0 -and
      ($CrossScaleFromPercent -notin $supportedScales -or $CrossScaleFromPercent -eq $ScalePercent)) {
    throw 'CrossScaleFromPercent must be zero or a different supported scale.'
  }
} elseif ($ScalePercent -ne 0 -or -not [string]::IsNullOrWhiteSpace($Theme) -or $CrossScaleFromPercent -ne 0) {
  throw 'ScalePercent, Theme and CrossScaleFromPercent are only valid for dwm-drag.'
}

$fileStem = if ($Scenario -eq 'dwm-drag') {
  "$Scenario-$Source-$ScalePercent-$Theme"
} else {
  "$Scenario-$Source"
}
$reportPath = Join-Path $resolvedOutput "$fileStem.report.json"
$progressPath = Join-Path $resolvedOutput "$fileStem.progress.json"
$completionPath = Join-Path $resolvedOutput "$fileStem.completion.json"
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
  $entryArguments += @(
    '--progress', $progressPath,
    '--completion', $completionPath,
    '--scale-percent', $ScalePercent,
    '--theme', $Theme
  )
  if ($CrossScaleFromPercent -ne 0) {
    $entryArguments += @('--cross-scale-from-percent', $CrossScaleFromPercent)
  }
  Write-Output "DWM runner will write ready/completed state to: $progressPath"
  Write-Output "This run records only the $ScalePercent%/$Theme combination; all twelve combinations are required."
  Write-Output "After actual visual checks, record completion with: node scripts/complete-i2-dwm-drag.js --progress `"$progressPath`" --completion `"$completionPath`""
} elseif ($Scenario -in @('device-removal-retry', 'sleep-wake-retry')) {
  $entryArguments += @('--progress', $progressPath, '--completion', $completionPath)
  Write-Output "Recovery runner will write product-observed state to: $progressPath"
  if ($Scenario -eq 'device-removal-retry') {
    Write-Output 'Wait for awaiting-device-removal, then actually unplug/disable and restore the active endpoint.'
  } else {
    Write-Output 'Wait for awaiting-system-suspend, then use Windows sleep and wake the machine.'
  }
  Write-Output "Only after the external action and restoration, record completion with: node scripts/complete-i2-recovery-action.js --scenario $Scenario --completion $completionPath"
}

& (Join-Path $PSScriptRoot 'run-electron-smoke.ps1') `
  -EntryPoint 'scripts/i2-live-interaction.js' `
  -EntryArguments $entryArguments `
  -LogDirectory (Join-Path $resolvedOutput 'logs') `
  -TimeoutSeconds ([Math]::Min(600, $TimeoutSeconds + 90))

$verifyArguments = @($reportPath, $Scenario)
if ($Scenario -eq 'dwm-drag') {
  $verifyArguments += @('--completion', $completionPath)
}
& node (Join-Path $PSScriptRoot 'verify-i2-interaction-report.js') @verifyArguments
if ($LASTEXITCODE -ne 0) { throw 'I2 interaction report verification failed.' }
Write-Output "I2 $Scenario interaction report: $reportPath"
