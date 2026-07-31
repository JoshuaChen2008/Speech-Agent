[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EntryPoint,

  [string[]]$EntryArguments = @(),

  [string]$LogDirectory = '.artifacts/electron-smoke-logs',

  [ValidateRange(5, 600)]
  [int]$TimeoutSeconds = 120
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
  -PassThru

# Windows PowerShell 5 can lose access to ExitCode after a very short child
# exits unless the exact process handle is materialized while it is alive.
[void]$process.Handle
$exited = $process.WaitForExit($TimeoutSeconds * 1000)
if (-not $exited) {
  try { $process.Kill() } catch { }
  try { $process.WaitForExit() } catch { }
  if (Test-Path -LiteralPath $stdoutPath) {
    Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stdoutPath
  }
  if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stderrPath
  }
  throw "Electron smoke exact process timed out after $TimeoutSeconds seconds. Logs: $resolvedLogDirectory"
}
# Ensure redirected asynchronous stream copies are fully drained before the
# runner reads their files.
$process.WaitForExit()
$process.Refresh()
$exitCode = $process.ExitCode

if (Test-Path -LiteralPath $stdoutPath) {
  Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stdoutPath
}
if ($exitCode -ne 0) {
  if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $stderrPath
  }
  throw "Electron smoke failed with exit code $exitCode. Logs: $resolvedLogDirectory"
}

Write-Output "Electron smoke completed without forcing process termination. Logs: $resolvedLogDirectory"
