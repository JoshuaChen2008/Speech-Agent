[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EntryPoint,

  [string[]]$EntryArguments = @(),

  [string]$LogDirectory = '.artifacts/electron-smoke-logs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw 'Electron is not installed. Run npm install first.'
}

$resolvedEntryPoint = if ([System.IO.Path]::IsPathRooted($EntryPoint)) {
  [System.IO.Path]::GetFullPath($EntryPoint)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $EntryPoint))
}
$projectPrefix = $projectRoot.TrimEnd('\') + '\'
if (-not $resolvedEntryPoint.StartsWith(
  $projectPrefix,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw 'Electron smoke entry point must stay inside the project workspace.'
}
if (-not (Test-Path -LiteralPath $resolvedEntryPoint -PathType Leaf) -or
  [System.IO.Path]::GetExtension($resolvedEntryPoint) -ne '.js') {
  throw "Electron smoke entry point is not a project JavaScript file: $EntryPoint"
}

$resolvedLogDirectory = if ([System.IO.Path]::IsPathRooted($LogDirectory)) {
  [System.IO.Path]::GetFullPath($LogDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $LogDirectory))
}
if (-not ($resolvedLogDirectory + '\').StartsWith(
  $projectPrefix,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw 'Electron smoke logs must stay inside the project workspace.'
}
New-Item -ItemType Directory -Force -Path $resolvedLogDirectory | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$name = [System.IO.Path]::GetFileNameWithoutExtension($resolvedEntryPoint)
$stdoutPath = Join-Path $resolvedLogDirectory "$name-$stamp.stdout.log"
$stderrPath = Join-Path $resolvedLogDirectory "$name-$stamp.stderr.log"
$processArguments = @($resolvedEntryPoint) + $EntryArguments

$process = Start-Process `
  -FilePath $electronPath `
  -ArgumentList $processArguments `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -Wait `
  -PassThru

if (Test-Path -LiteralPath $stdoutPath) {
  Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stdoutPath
}
if ($process.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stderrPath
  }
  throw "Electron smoke failed with exit code $($process.ExitCode). Logs: $resolvedLogDirectory"
}

Write-Output "Electron smoke completed without forcing process termination. Logs: $resolvedLogDirectory"
