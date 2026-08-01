[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('loopback', 'mic')]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Report,

  [ValidateSet('acceptance', 'qualification')]
  [string]$Mode = 'acceptance',

  [string]$ModelUserData = '.artifacts\model-install-live-20260731-3\user-data',

  [string]$PhysicalMicPreflight,

  [string]$ArtifactDirectory,

  [string]$Progress,

  [switch]$KeepArtifacts,

  [ValidateRange(5, 180)]
  [int]$TimeoutMinutes = 155
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
  The regular smoke runner intentionally caps Electron at ten minutes.  I3
  must never reuse that cap: this wrapper gives the real wall-clock runner a
  bounded 155-minute watchdog by default. Qualification mode is a separately
  verified 75-second partial real-audio probe with a fixed worker recovery.
  It launches controlled audible playback, so invoke it only after the
  operator has explicitly approved the I3 audio session.
#>

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw 'Electron is not installed. Run npm install first.'
}

if ($Source -eq 'mic' -and [string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
  throw 'PhysicalMicPreflight is required for the microphone acoustic I3 soak.'
}
if ($Source -eq 'loopback' -and -not [string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
  throw 'PhysicalMicPreflight is only valid for Source mic.'
}

$entryPoint = Join-Path $projectRoot 'scripts\i3-live-audio-soak.js'
$resolvedReport = if ([System.IO.Path]::IsPathRooted($Report)) {
  [System.IO.Path]::GetFullPath($Report)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $Report))
}
$arguments = @($entryPoint, '--source', $Source, '--report', $resolvedReport)
if ($Mode -eq 'qualification') { $arguments += @('--mode', 'qualification') }
if ([string]::IsNullOrWhiteSpace($ModelUserData)) { throw 'ModelUserData cannot be empty.' }
$resolvedModelUserData = if ([System.IO.Path]::IsPathRooted($ModelUserData)) {
  [System.IO.Path]::GetFullPath($ModelUserData)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $ModelUserData))
}
$arguments += @('--model-user-data', $resolvedModelUserData)
if (-not [string]::IsNullOrWhiteSpace($PhysicalMicPreflight)) {
  $arguments += @('--physical-mic-preflight', [System.IO.Path]::GetFullPath($PhysicalMicPreflight))
}
if (-not [string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
  $arguments += @('--artifact-directory', [System.IO.Path]::GetFullPath($ArtifactDirectory))
}
if (-not [string]::IsNullOrWhiteSpace($Progress)) {
  $arguments += @('--progress', [System.IO.Path]::GetFullPath($Progress))
}
if ($KeepArtifacts) { $arguments += '--keep-artifacts' }

$logDirectory = Join-Path $projectRoot '.artifacts\i3-live-audio\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdoutPath = Join-Path $logDirectory "i3-live-audio-$stamp.stdout.log"
$stderrPath = Join-Path $logDirectory "i3-live-audio-$stamp.stderr.log"

$process = Start-Process -FilePath $electronPath -ArgumentList $arguments -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
[void]$process.Handle
if (-not $process.WaitForExit($TimeoutMinutes * 60 * 1000)) {
  try { $process.Kill() } catch { }
  try { $process.WaitForExit() } catch { }
  throw "I3 live audio soak exceeded its $TimeoutMinutes-minute watchdog. Exact process was stopped. Logs: $logDirectory"
}
$process.WaitForExit()
$process.Refresh()
if ($process.ExitCode -ne 0) {
  throw "I3 live audio soak failed with exit code $($process.ExitCode). Logs: $logDirectory"
}

$verificationArguments = if ($Mode -eq 'qualification') { @('--qualification', $resolvedReport) } else { @($resolvedReport) }
& node (Join-Path $projectRoot 'scripts\verify-i3-live-audio-report.js') $verificationArguments
if ($LASTEXITCODE -ne 0) { throw 'I3 report verifier rejected the completed run.' }
Write-Output "I3 $Mode audio run completed and passed its strict verifier. Report: $resolvedReport"
