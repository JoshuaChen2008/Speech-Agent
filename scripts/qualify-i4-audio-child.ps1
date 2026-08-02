[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('loopback', 'mic')]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [string]$B5LayoutEvidence,

  [Parameter(Mandatory = $true)]
  [string]$NonAudioReport,

  [string]$PriorLoopbackChildReport,

  [Parameter(Mandatory = $true)]
  [string]$ExportRoot,

  [Parameter(Mandatory = $true)]
  [string]$Report
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Operator-driven I4 real-source child. This script observes exact files,
# processes, SQLite headers, export hashes and privacy negatives. Permission,
# visible caption and native-dialog behavior remain explicit operator evidence;
# the runner does not automate UI or add a product test entry point.

$ExpectedUserDataName = 'live-subtitle-agent'
$DownloadHosts = @(
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
)
$AudioExtensionPattern = '(?i)\.(wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[^a-z0-9])'
$Sha256Pattern = '^[a-f0-9]{64}$'

function Get-AbsoluteExistingFile {
  param([string]$Value, [string]$Label)
  $resolved = Resolve-Path -LiteralPath $Value -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
    throw "$Label must be an existing file."
  }
  return [IO.Path]::GetFullPath($resolved.Path)
}

function Get-AbsolutePath {
  param([string]$Value)
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Value))
}

function Get-Sha256 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Assert-Confirmation {
  param([string]$Expected, [string]$Prompt)
  if ((Read-Host $Prompt) -cne $Expected) { throw "Operator confirmation did not match $Expected." }
}

function Test-HasGitAncestor {
  param([string]$Path)
  $cursor = if (Test-Path -LiteralPath $Path -PathType Leaf) {
    [IO.Directory]::GetParent([IO.Path]::GetFullPath($Path))
  } else {
    [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path))
  }
  while ($null -ne $cursor) {
    if (Test-Path -LiteralPath (Join-Path $cursor.FullName '.git')) { return $true }
    $cursor = $cursor.Parent
  }
  return $false
}

function Test-DownloadHostReachable {
  param([string]$HostName)
  try {
    $response = Invoke-WebRequest -Uri "https://$HostName/" -Method Head -UseBasicParsing -TimeoutSec 15
    return $null -ne $response
  } catch {
    if ($null -ne $_.Exception.Response) { return $true }
    return $false
  }
}

function Assert-AllDownloadHostsUnreachable {
  foreach ($hostName in $DownloadHosts) {
    if (Test-DownloadHostReachable $hostName) {
      throw "Production download host remained reachable: $hostName"
    }
  }
}

function Assert-B5LayoutEvidence {
  param([object]$Layout)
  if ($null -eq $Layout -or [int]$Layout.schemaVersion -ne 2 -or
      $Layout.kind -cne 'packaged-layout-qualification' -or $Layout.result -cne 'pass' -or
      $Layout.gateStatus -cne 'packaged-ci-qualified' -or $Layout.artifact.variant -cne 'release' -or
      $Layout.artifact.arch -cne 'x64' -or $Layout.artifact.installerPresent -ne $true -or
      [string]::IsNullOrWhiteSpace([string]$Layout.artifact.productPayloadVersion) -or
      [int]$Layout.artifact.productPayloadFileCount -lt 1) {
    throw 'B5 layout evidence has the wrong release envelope.'
  }
  foreach ($digest in @(
    $Layout.artifact.installerSha256,
    $Layout.artifact.appExecutableSha256,
    $Layout.artifact.appAsarSha256,
    $Layout.artifact.productPayloadSha256
  )) {
    if ([string]$digest -cnotmatch $Sha256Pattern) { throw 'B5 layout evidence contains an invalid digest.' }
  }
}

function Assert-NonAudioReportBinding {
  param([object]$Value, [object]$Layout)
  if ($null -eq $Value -or [int]$Value.schemaVersion -ne 3 -or
      $Value.kind -cne 'i4-nonaudio-nsis-qualification' -or
      $Value.result -cne 'pass' -or $Value.gateStatus -cne 'partial' -or
      $Value.artifact.installerSha256 -cne $Layout.artifact.installerSha256 -or
      $Value.artifact.installedExecutableSha256 -cne $Layout.artifact.appExecutableSha256 -or
      $Value.artifact.installedAsarSha256 -cne $Layout.artifact.appAsarSha256 -or
      $Value.artifact.productPayloadSha256 -cne $Layout.artifact.productPayloadSha256 -or
      $Value.offlineRestart.downloadHostsUnreachableAtRestart -ne $true -or
      $Value.dataLifecycle.preservationManifestUnchangedThroughReinstall -ne $true) {
    throw 'I4 non-audio child is not a pass/partial report for the exact B5 candidate.'
  }
  if (@('vm-host-vnic-disconnect', 'preconfigured-outbound-block') -cnotcontains
      [string]$Value.offlineRestart.offlineControl) {
    throw 'I4 non-audio child has an invalid offline control.'
  }
}

function Get-InstalledExecutable {
  param([string]$ProgramsRoot)
  $matches = @(
    Get-ChildItem -LiteralPath $ProgramsRoot -Filter 'LiveSubtitle.exe' -File -Recurse -ErrorAction Stop
  )
  if ($matches.Count -ne 1) {
    throw "Expected exactly one installed LiveSubtitle.exe, found $($matches.Count)."
  }
  return $matches[0].FullName
}

function Assert-InstalledFilesMatchB5 {
  param([string]$Executable, [object]$Layout)
  $asar = Join-Path (Split-Path -Parent $Executable) 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'Installed app.asar is missing.' }
  $exeSha = Get-Sha256 $Executable
  $asarSha = Get-Sha256 $asar
  if ($exeSha -cne $Layout.artifact.appExecutableSha256 -or
      $asarSha -cne $Layout.artifact.appAsarSha256) {
    throw 'Installed executable or app.asar differs from the B5 layout.'
  }
  return [pscustomobject][ordered]@{ executableSha256 = $exeSha; asarSha256 = $asarSha }
}

function Get-ExactApplicationProcesses {
  param([string]$Executable)
  return @(
    Get-CimInstance Win32_Process -Filter "Name='LiveSubtitle.exe'" |
      Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $Executable }
  )
}

function Assert-NoExactApplicationProcess {
  param([string]$Executable)
  if ((Get-ExactApplicationProcesses $Executable).Count -ne 0) {
    throw 'The exact installed candidate is already running; audio children must be serialized.'
  }
}

function Wait-ExactApplicationExit {
  param([Diagnostics.Process]$StartedProcess, [string]$Executable, [int]$TimeoutSeconds = 180)
  if (-not $StartedProcess.WaitForExit($TimeoutSeconds * 1000)) {
    throw 'The exact release application did not exit normally in time.'
  }
  if ($StartedProcess.ExitCode -ne 0) {
    throw "The exact release application exited with code $($StartedProcess.ExitCode)."
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ((Get-ExactApplicationProcesses $Executable).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'A process from the exact installed application remained after normal exit.'
}

function Assert-SqliteHeader {
  param([string]$DatabasePath)
  $stream = [IO.File]::OpenRead($DatabasePath)
  try {
    $header = New-Object byte[] 16
    if ($stream.Read($header, 0, 16) -ne 16 -or
        [Text.Encoding]::ASCII.GetString($header) -cne "SQLite format 3$([char]0)") {
      throw 'The product history database has no SQLite format header.'
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-ExportEvidence {
  param([string]$Path, [ValidateSet('txt', 'md', 'srt')][string]$Format)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The $Format native-dialog export is missing."
  }
  $content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  $recordCount = switch ($Format) {
    'txt' { @([regex]::Split($content.TrimEnd(), '\r?\n') | Where-Object { $_.Length -gt 0 }).Count }
    'md' { [regex]::Matches($content, '(?m)^- ').Count }
    'srt' { [regex]::Matches($content, '(?m)^\d+\r?$').Count }
  }
  if ($recordCount -lt 1) { throw "The $Format export contains no subtitle records." }
  return [pscustomobject][ordered]@{
    bytes = (Get-Item -LiteralPath $Path).Length
    recordCount = $recordCount
    sha256 = Get-Sha256 $Path
  }
}

function Get-ExportSet {
  param([string]$Root, [string]$Prefix)
  $set = [pscustomobject][ordered]@{
    text = Get-ExportEvidence (Join-Path $Root "$Prefix.txt") 'txt'
    markdown = Get-ExportEvidence (Join-Path $Root "$Prefix.md") 'md'
    srt = Get-ExportEvidence (Join-Path $Root "$Prefix.srt") 'srt'
  }
  if ($set.text.recordCount -ne $set.markdown.recordCount -or
      $set.text.recordCount -ne $set.srt.recordCount) {
    throw 'The three export formats have different record counts.'
  }
  return $set
}

function Assert-ExportSetsMatch {
  param([object]$Before, [object]$After)
  foreach ($format in @('text', 'markdown', 'srt')) {
    if ($Before.$format.bytes -ne $After.$format.bytes -or
        $Before.$format.recordCount -ne $After.$format.recordCount -or
        $Before.$format.sha256 -cne $After.$format.sha256) {
      throw "The offline restart produced a different $format export."
    }
  }
}

function Get-AudioPrivacyCounts {
  param([string[]]$Roots)
  $files = @()
  foreach ($root in $Roots) { $files += @(Get-ChildItem -LiteralPath $root -File -Recurse -Force) }
  $audioFiles = @($files | Where-Object { $_.Name -match $AudioExtensionPattern })
  $referenceCount = 0
  $textExtensions = @('.json', '.jsonl', '.log', '.txt', '.md', '.srt', '.sqlite3', '.db')
  foreach ($file in $files) {
    if ($textExtensions -contains $file.Extension.ToLowerInvariant()) {
      $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file.FullName))
      $referenceCount += [regex]::Matches($text, $AudioExtensionPattern).Count
    }
  }
  return [pscustomobject][ordered]@{
    audioFileCount = $audioFiles.Count
    persistedAudioReferenceCount = $referenceCount
  }
}

if ($env:OS -cne 'Windows_NT' -or [Environment]::OSVersion.Version.Build -lt 22000) {
  throw 'I4 audio qualification requires Windows 11 build 22000 or newer.'
}
if (-not [Environment]::UserInteractive) { throw 'An interactive desktop is required.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run from a non-elevated dedicated standard-user account.'
}
if ($null -ne (Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'Node.js must not be available in the dedicated qualification account.'
}
if ($Source -ceq 'loopback' -and -not [string]::IsNullOrWhiteSpace($PriorLoopbackChildReport)) {
  throw 'The first loopback child cannot accept a prior audio child.'
}
if ($Source -ceq 'mic' -and [string]::IsNullOrWhiteSpace($PriorLoopbackChildReport)) {
  throw 'The mic child requires the prior loopback child report.'
}

$InstallerPath = Get-AbsoluteExistingFile $Installer 'Installer'
$B5LayoutPath = Get-AbsoluteExistingFile $B5LayoutEvidence 'B5 layout evidence'
$NonAudioReportPath = Get-AbsoluteExistingFile $NonAudioReport 'I4 non-audio report'
$PriorLoopbackPath = if ($Source -ceq 'mic') {
  Get-AbsoluteExistingFile $PriorLoopbackChildReport 'Prior loopback child report'
} else { $null }
$ExportRootPath = Get-AbsolutePath $ExportRoot
$ReportPath = Get-AbsolutePath $Report
if (Test-Path -LiteralPath $ExportRootPath) { throw 'ExportRoot must not already exist.' }
if (Test-Path -LiteralPath $ReportPath) { throw 'Report must not already exist.' }
foreach ($probe in (@(
  $PSScriptRoot, $InstallerPath, $B5LayoutPath, $NonAudioReportPath,
  $PriorLoopbackPath, $ExportRootPath, $ReportPath, (Get-Location).Path
) | Where-Object { $null -ne $_ })) {
  if (Test-HasGitAncestor $probe) { throw 'All qualification inputs must execute outside a Git repository.' }
}

$B5LayoutEvidenceSha256 = Get-Sha256 $B5LayoutPath
$B5Layout = Get-Content -LiteralPath $B5LayoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-B5LayoutEvidence $B5Layout
$InstallerSha256 = Get-Sha256 $InstallerPath
if ($InstallerSha256 -cne $B5Layout.artifact.installerSha256) {
  throw 'Installer SHA-256 does not match the B5 layout evidence.'
}
$NonAudioReportSha256 = Get-Sha256 $NonAudioReportPath
$NonAudio = Get-Content -LiteralPath $NonAudioReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-NonAudioReportBinding $NonAudio $B5Layout

$PriorLoopbackSha256 = $null
if ($Source -ceq 'mic') {
  $prior = Get-Content -LiteralPath $PriorLoopbackPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $PriorLoopbackSha256 = Get-Sha256 $PriorLoopbackPath
  if ([int]$prior.schemaVersion -ne 1 -or $prior.kind -cne 'i4-audio-source-child' -or
      $prior.sourceId -cne 'loopback' -or $prior.result -cne 'pass' -or
      $prior.gateStatus -cne 'partial' -or
      $prior.artifact.nonAudioReportSha256 -cne $NonAudioReportSha256 -or
      $prior.artifact.installerSha256 -cne $InstallerSha256) {
    throw 'The prior loopback child is not bound to this candidate and non-audio child.'
  }
}

$RoamingRoot = [Environment]::GetFolderPath('ApplicationData')
$LocalRoot = [Environment]::GetFolderPath('LocalApplicationData')
$ProgramsRoot = Join-Path $LocalRoot 'Programs'
$UserData = Join-Path $RoamingRoot $ExpectedUserDataName
$ConfigPath = Join-Path $UserData 'config.json'
$DatabasePath = Join-Path $UserData 'data\speech-agent.sqlite3'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
  throw 'The completed I4 non-audio userData baseline is missing.'
}
Assert-SqliteHeader $DatabasePath
$InstalledExecutable = Get-InstalledExecutable $ProgramsRoot
$InstalledIdentity = Assert-InstalledFilesMatchB5 $InstalledExecutable $B5Layout
Assert-NoExactApplicationProcess $InstalledExecutable
Assert-AllDownloadHostsUnreachable

$reportParent = Split-Path -Parent $ReportPath
if (-not (Test-Path -LiteralPath $reportParent -PathType Container)) {
  New-Item -ItemType Directory -Path $reportParent | Out-Null
}
New-Item -ItemType Directory -Path $ExportRootPath | Out-Null

$sourceLabel = if ($Source -ceq 'loopback') { 'system audio' } else { 'physical microphone audio' }
Write-Host @"
The exact B5-bound release will start for the $Source permission-denial phase.
1. Select only $sourceLabel; the other audio source must remain inactive.
2. Use the real Windows/application permission control to deny this source's media request.
3. Press Start once. Confirm the denial is visibly reported and no caption appears.
4. Close the application normally, then enter the token.
"@
$denialProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation "I4-$($Source.ToUpperInvariant())-PERMISSION-DENIED" 'Type the displayed permission-denial token after normal close'
Wait-ExactApplicationExit $denialProcess $InstalledExecutable
Assert-NoExactApplicationProcess $InstalledExecutable
Assert-SqliteHeader $DatabasePath
$SqliteShaBeforeCapture = Get-Sha256 $DatabasePath
$SqliteBytesBeforeCapture = (Get-Item -LiteralPath $DatabasePath).Length

$beforePrefix = "$Source-before-offline"
$beforeTxt = Join-Path $ExportRootPath "$beforePrefix.txt"
$beforeMd = Join-Path $ExportRootPath "$beforePrefix.md"
$beforeSrt = Join-Path $ExportRootPath "$beforePrefix.srt"
Write-Host @"
The exact release will start for the real $sourceLabel journey.
1. Approve the real media permission and keep only $Source selected.
2. Start one new session using real source audio, not a fixture or virtual replay.
3. Observe a temporary caption, a first-pass final, and a refinement result.
4. Pause; confirm no new caption is published while paused. Resume and observe another caption.
5. Stop normally. Open History and select this exact new session.
6. Export it through native Save dialogs to these exact files:
   $beforeTxt
   $beforeMd
   $beforeSrt
7. Close normally, then enter the token.
"@
$captureProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation "I4-$($Source.ToUpperInvariant())-SOURCE-JOURNEY" 'Type the displayed real-source token after exports and normal close'
Wait-ExactApplicationExit $captureProcess $InstalledExecutable
Assert-NoExactApplicationProcess $InstalledExecutable
Assert-SqliteHeader $DatabasePath
$SqliteShaAfterStop = Get-Sha256 $DatabasePath
$SqliteBytesAfterStop = (Get-Item -LiteralPath $DatabasePath).Length
if ($SqliteShaAfterStop -ceq $SqliteShaBeforeCapture) {
  throw 'SQLite did not change during the approved real-source journey.'
}
$BeforeOfflineExports = Get-ExportSet $ExportRootPath $beforePrefix

Assert-AllDownloadHostsUnreachable
$afterPrefix = "$Source-after-offline"
$afterTxt = Join-Path $ExportRootPath "$afterPrefix.txt"
$afterMd = Join-Path $ExportRootPath "$afterPrefix.md"
$afterSrt = Join-Path $ExportRootPath "$afterPrefix.srt"
Write-Host @"
The exact release will restart while production download hosts remain unreachable.
1. Do not press Start and do not acquire either audio source.
2. Open History, select the same $Source session, and export through native Save dialogs to:
   $afterTxt
   $afterMd
   $afterSrt
3. Close normally, then enter the token.
"@
$offlineProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation "I4-$($Source.ToUpperInvariant())-OFFLINE-HISTORY" 'Type the displayed offline-history token after exports and normal close'
Wait-ExactApplicationExit $offlineProcess $InstalledExecutable
Assert-NoExactApplicationProcess $InstalledExecutable
$AfterOfflineExports = Get-ExportSet $ExportRootPath $afterPrefix
Assert-ExportSetsMatch $BeforeOfflineExports $AfterOfflineExports
Assert-SqliteHeader $DatabasePath

$Privacy = Get-AudioPrivacyCounts @($UserData, $ExportRootPath)
if ($Privacy.audioFileCount -ne 0 -or $Privacy.persistedAudioReferenceCount -ne 0) {
  throw 'The I4 audio child left an audio file or persisted audio reference.'
}

$qualification = [pscustomobject][ordered]@{
  schemaVersion = 1
  kind = 'i4-audio-source-child'
  generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  result = 'pass'
  gateStatus = 'partial'
  sourceId = $Source
  environment = [pscustomobject][ordered]@{
    osFamily = 'windows'
    osBuild = [Environment]::OSVersion.Version.Build
    harnessVerifiedInteractiveDesktop = $true
    harnessVerifiedNodeCommandAbsent = $true
    harnessVerifiedNonElevated = $true
    harnessVerifiedRepositoryAncestorsAbsent = $true
    downloadHostsUnreachable = $true
    offlineControl = [string]$NonAudio.offlineRestart.offlineControl
  }
  artifact = [pscustomobject][ordered]@{
    b5LayoutEvidenceSha256 = $B5LayoutEvidenceSha256
    nonAudioReportSha256 = $NonAudioReportSha256
    installerSha256 = $InstallerSha256
    installedExecutableSha256 = $InstalledIdentity.executableSha256
    installedAsarSha256 = $InstalledIdentity.asarSha256
    productPayloadVersion = [string]$B5Layout.artifact.productPayloadVersion
    productPayloadFileCount = [int]$B5Layout.artifact.productPayloadFileCount
    productPayloadSha256 = [string]$B5Layout.artifact.productPayloadSha256
    exactCandidateBound = $true
  }
  ordering = [pscustomobject][ordered]@{
    ordinal = if ($Source -ceq 'loopback') { 1 } else { 2 }
    priorLoopbackChildReportSha256 = $PriorLoopbackSha256
    harnessVerifiedNoExactCandidateProcessBeforeLaunch = $true
    harnessVerifiedSerializedExactLaunches = $true
    operatorAttestedOtherSourceInactive = $true
  }
  permission = [pscustomobject][ordered]@{
    operatorAttestedPermissionDenied = $true
    operatorAttestedPermissionDenialVisible = $true
    operatorAttestedNoCaptionDuringDenial = $true
    operatorAttestedPermissionApproved = $true
  }
  sourceEvidence = [pscustomobject][ordered]@{
    operatorAttestedRealSourceAudio = $true
    operatorAttestedNoFixtureOrVirtualReplay = $true
    operatorAttestedPhysicalMicrophoneSource = ($Source -ceq 'mic')
    operatorAttestedSystemAudioSource = ($Source -ceq 'loopback')
  }
  journey = [pscustomobject][ordered]@{
    harnessObservedPermissionDenialLaunchNormalExit = $true
    harnessObservedCaptureLaunchNormalExit = $true
    harnessObservedOfflineRestartNormalExit = $true
    operatorAttestedSourceSelected = $true
    operatorAttestedStarted = $true
    operatorAttestedPartialVisible = $true
    operatorAttestedFirstPassFinalVisible = $true
    operatorAttestedRefinementVisible = $true
    operatorAttestedPaused = $true
    operatorAttestedNoNewCaptionWhilePaused = $true
    operatorAttestedResumed = $true
    operatorAttestedCaptionAfterResume = $true
    operatorAttestedStopped = $true
    operatorAttestedHistorySessionVisible = $true
    operatorAttestedNativeSaveDialogs = $true
    operatorAttestedNoCaptureDuringOfflineRestart = $true
  }
  sqlite = [pscustomobject][ordered]@{
    harnessSqliteHeaderValidBefore = $true
    harnessSqliteHeaderValidAfter = $true
    bytesBeforeCapture = [int64]$SqliteBytesBeforeCapture
    bytesAfterStop = [int64]$SqliteBytesAfterStop
    sha256BeforeCapture = $SqliteShaBeforeCapture
    sha256AfterStop = $SqliteShaAfterStop
    harnessSqliteChangedAfterJourney = $true
  }
  exports = [pscustomobject][ordered]@{
    beforeOfflineRestart = $BeforeOfflineExports
    afterOfflineRestart = $AfterOfflineExports
    harnessVerifiedOfflineExportsMatch = $true
  }
  privacy = [pscustomobject][ordered]@{
    harnessAudioFileCount = 0
    harnessPersistedAudioReferenceCount = 0
    reportContainsTranscriptText = $false
    reportContainsDeviceName = $false
    reportContainsAbsolutePath = $false
  }
  limitations = @(
    'operator-driven-permission-and-gui-observation',
    'single-source-child-only',
    'does-not-close-i2-performance-or-i3-soak',
    'unsigned-installer',
    'i4-full-status-partial'
  )
}

$json = $qualification | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($ReportPath, $json + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "I4 $Source audio child pass/partial report written. Full I4 still requires strict summary."
