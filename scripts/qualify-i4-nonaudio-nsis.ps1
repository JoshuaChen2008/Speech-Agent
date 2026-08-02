[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [string]$B5LayoutEvidence,

  [Parameter(Mandatory = $true)]
  [string]$LegacyFixture,

  [Parameter(Mandatory = $true)]
  [string]$ExportRoot,

  [Parameter(Mandatory = $true)]
  [string]$Report,

  [Parameter(Mandatory = $true)]
  [ValidateSet('vm-host-vnic-disconnect', 'preconfigured-outbound-block')]
  [string]$OfflineControl,

  [Parameter(Mandatory = $true)]
  [switch]$AttestCleanWindowsSnapshot,

  [Parameter(Mandatory = $true)]
  [switch]$AttestCleanUserProfile,

  [Parameter(Mandatory = $true)]
  [switch]$AttestDedicatedStandardUser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# External, operator-driven release qualification. Copy this script, the exact
# installer, the tracked B5 layout JSON and the fixed fixture into a dedicated
# Windows 11 standard-user snapshot. This runner never drives Start, media
# permission UI or an audio device, and never terminates a process by name.

$ExpectedModels = @(
  [pscustomobject][ordered]@{
    artifactId = 'x-asr-160ms'
    resourceGroup = 'core'
    bytes = 133898007
    sourceSha256 = '8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399'
    installId = 'x-asr-160ms'
    directoryName = 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
    requiredFiles = @('tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx')
  },
  [pscustomobject][ordered]@{
    artifactId = 'x-asr-offline'
    resourceGroup = 'refinement'
    bytes = 136396739
    sourceSha256 = '5d02c36d7b44e886b7c8f0d8e051f8713acab96c264bb6ef9e718be39a6a2224'
    installId = 'x-asr-offline'
    directoryName = 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03'
    requiredFiles = @(
      'tokens.txt',
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.int8.onnx'
    )
  },
  [pscustomobject][ordered]@{
    artifactId = 'silero-vad'
    resourceGroup = 'core'
    bytes = 643854
    sourceSha256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
    installId = 'silero-vad'
    directoryName = $null
    requiredFiles = @('silero_vad.onnx')
  }
)
$CoreModels = @($ExpectedModels | Where-Object { $_.resourceGroup -ceq 'core' })
$RefinementModels = @($ExpectedModels | Where-Object { $_.resourceGroup -ceq 'refinement' })
$ManifestAllowedDownloadHosts = @(
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
)
$ExpectedCoreDownloadedBytes = ($CoreModels | Measure-Object -Property bytes -Sum).Sum
$ExpectedRefinementDownloadedBytes = ($RefinementModels | Measure-Object -Property bytes -Sum).Sum
$ExpectedModelFileCount = @($ExpectedModels | ForEach-Object { $_.requiredFiles }).Count
$ExpectedCoreModelFileCount = @($CoreModels | ForEach-Object { $_.requiredFiles }).Count
$ExpectedRefinementModelFileCount = @($RefinementModels | ForEach-Object { $_.requiredFiles }).Count
$ExpectedPreservationEntryCount = 3 + $ExpectedModels.Count + $ExpectedModelFileCount
$FixtureText = 'I4 non-audio migration fixture'
$ExpectedUserDataName = 'live-subtitle-agent'
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
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BytesSha256 {
  param([byte[]]$Bytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
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

function Get-TopLevelDirectorySet {
  param([string]$Root)
  $set = @{}
  foreach ($directory in @(Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction Stop)) {
    $set[$directory.FullName.ToLowerInvariant()] = $true
  }
  return $set
}

function Test-DownloadHostReachable {
  param([string]$HostName)
  try {
    $response = Invoke-WebRequest -Uri "https://$HostName/" -Method Head -UseBasicParsing -TimeoutSec 15
    return $null -ne $response
  } catch {
    # Any HTTP response proves a network path even if the host root rejects HEAD.
    if ($null -ne $_.Exception.Response) { return $true }
    return $false
  }
}

function Assert-AllDownloadHostsReachable {
  foreach ($hostName in $ManifestAllowedDownloadHosts) {
    if (-not (Test-DownloadHostReachable $hostName)) {
      throw "Production download host is unreachable before download: $hostName"
    }
  }
}

function Assert-AllDownloadHostsUnreachable {
  param([string]$Phase)
  foreach ($hostName in $ManifestAllowedDownloadHosts) {
    if (Test-DownloadHostReachable $hostName) {
      throw "Production download host remained reachable during ${Phase}: $hostName"
    }
  }
}

function Assert-B5LayoutEvidence {
  param([object]$Layout)
  if ($null -eq $Layout -or [int]$Layout.schemaVersion -ne 2 -or
      $Layout.kind -cne 'packaged-layout-qualification' -or $Layout.result -cne 'pass' -or
      $Layout.gateStatus -cne 'packaged-ci-qualified' -or $Layout.artifact.variant -cne 'release' -or
      $Layout.artifact.arch -cne 'x64' -or [string]::IsNullOrWhiteSpace([string]$Layout.artifact.mainEntry) -or
      $Layout.artifact.installerPresent -ne $true -or $Layout.artifact.signingStatus -cne 'not-signed' -or
      [string]::IsNullOrWhiteSpace([string]$Layout.artifact.productPayloadVersion) -or
      [int]$Layout.artifact.productPayloadFileCount -lt 1) {
    throw 'B5 layout evidence has the wrong release envelope.'
  }
  foreach ($value in @(
    $Layout.artifact.installerSha256,
    $Layout.artifact.appExecutableSha256,
    $Layout.artifact.appAsarSha256,
    $Layout.artifact.productPayloadSha256
  )) {
    if ([string]$value -cnotmatch $Sha256Pattern) { throw 'B5 layout evidence contains an invalid digest.' }
  }
}

function Get-InstalledExecutable {
  param([string]$ProgramsRoot)
  if (-not (Test-Path -LiteralPath $ProgramsRoot -PathType Container)) {
    throw 'The per-user Programs directory was not created by NSIS.'
  }
  $matches = @(Get-ChildItem -LiteralPath $ProgramsRoot -Filter 'LiveSubtitle.exe' -File -Recurse)
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
    throw 'Installed executable or app.asar differs from the tracked B5 layout.'
  }
  return [pscustomobject][ordered]@{ executableSha256 = $exeSha; asarSha256 = $asarSha }
}

function Wait-PathAbsent {
  param([string]$Path, [int]$TimeoutSeconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw 'The NSIS uninstall directory still exists after the timeout.'
}

function Wait-ExactApplicationExit {
  param([Diagnostics.Process]$StartedProcess, [string]$Executable, [int]$TimeoutSeconds = 60)
  if (-not $StartedProcess.WaitForExit($TimeoutSeconds * 1000)) {
    throw 'The exact release application did not exit normally in time.'
  }
  if ($StartedProcess.ExitCode -ne 0) {
    throw "The exact release application exited with code $($StartedProcess.ExitCode)."
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @(
      Get-CimInstance Win32_Process -Filter "Name='LiveSubtitle.exe'" |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $Executable }
    )
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'A process from the exact installed application remained after normal exit.'
}

function Find-NewUserDataDirectory {
  param([string]$RoamingRoot, [hashtable]$Before)
  $candidates = @(
    Get-ChildItem -LiteralPath $RoamingRoot -Directory -Force |
      Where-Object {
        -not $Before.ContainsKey($_.FullName.ToLowerInvariant()) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'models') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'data\speech-agent.sqlite3') -PathType Leaf)
      }
  )
  if ($candidates.Count -ne 1) {
    throw "Could not uniquely discover the new release userData directory; found $($candidates.Count)."
  }
  if ($candidates[0].Name -cne $ExpectedUserDataName) {
    throw "The discovered userData name was $($candidates[0].Name), not $ExpectedUserDataName."
  }
  return $candidates[0].FullName
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

function Assert-ExactMarkerProperties {
  param([object]$Marker)
  if ((@($Marker.PSObject.Properties.Name | Sort-Object) -join ',') -cne
      'artifactId,bytes,manifestVersion,sha256') {
    throw 'A ready marker has unexpected properties.'
  }
}

function Get-ExpectedModelTarget {
  param([string]$UserData, [object]$Expected)
  $target = Join-Path (Join-Path $UserData 'models') $Expected.installId
  if ($null -ne $Expected.directoryName) { $target = Join-Path $target $Expected.directoryName }
  return $target
}

function Get-ModelFilePaths {
  param([string]$UserData, [object[]]$Models = $ExpectedModels)
  $paths = @()
  foreach ($expected in $Models) {
    $target = Get-ExpectedModelTarget $UserData $expected
    foreach ($name in $expected.requiredFiles) { $paths += Join-Path $target $name }
  }
  return $paths
}

function Get-ReadyMarkerEvidence {
  param([string]$UserData, [object[]]$Models = $ExpectedModels)
  $modelsRoot = Join-Path $UserData 'models'
  $evidence = @()
  foreach ($expected in $Models) {
    $target = Get-ExpectedModelTarget $UserData $expected
    $markerPath = Join-Path $target '.ready.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
      throw "Missing ready marker for $($expected.artifactId)."
    }
    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ExactMarkerProperties $marker
    if ([int64]$marker.manifestVersion -ne 1 -or $marker.artifactId -cne $expected.artifactId -or
        [int64]$marker.bytes -ne [int64]$expected.bytes -or
        $marker.sha256 -cne $expected.sourceSha256) {
      throw "Ready marker mismatch for $($expected.artifactId)."
    }
    foreach ($required in @($expected.requiredFiles | ForEach-Object { Join-Path $target $_ })) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf) -or
          (Get-Item -LiteralPath $required).Length -lt 1) {
        throw "Required model file is missing for $($expected.artifactId)."
      }
    }
    $evidence += [pscustomobject][ordered]@{
      artifactId = $expected.artifactId
      bytes = [int64]$expected.bytes
      sourceSha256 = $expected.sourceSha256
      markerSha256 = Get-Sha256 $markerPath
    }
  }
  if (@(Get-ChildItem -LiteralPath $modelsRoot -Filter '.ready.json' -File -Recurse -Force).Count -ne
      $Models.Count) {
    throw 'The models directory contains an unexpected ready-marker count.'
  }
  foreach ($temporaryName in @('.downloads', '.staging')) {
    $temporary = Join-Path $modelsRoot $temporaryName
    if ((Test-Path -LiteralPath $temporary -PathType Container) -and
        @(Get-ChildItem -LiteralPath $temporary -Force).Count -ne 0) {
      throw "Model $temporaryName was not clean after installation."
    }
  }
  return $evidence
}

function Get-RefinementPreference {
  param([string]$ConfigPath)
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $config.PSObject.Properties['refinementEnabled'] -or
      $config.refinementEnabled -isnot [bool]) {
    throw 'The product config has no boolean refinementEnabled preference.'
  }
  return [bool]$config.refinementEnabled
}

function Get-PreservationManifest {
  param([string]$UserData, [string[]]$Paths)
  $lines = @()
  foreach ($item in @($Paths | Sort-Object)) {
    if (-not (Test-Path -LiteralPath $item -PathType Leaf)) {
      throw 'A selected application-data preservation file is missing.'
    }
    $relative = $item.Substring($UserData.Length).TrimStart('\', '/').Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('../')) {
      throw 'A preservation path escaped userData.'
    }
    $lines += "$relative|$((Get-Item -LiteralPath $item).Length)|$(Get-Sha256 $item)"
  }
  $payload = [Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n") + "`n")
  return [pscustomobject][ordered]@{ entryCount = $lines.Count; sha256 = Get-BytesSha256 $payload }
}

function Get-ExportEvidence {
  param([string]$Path, [ValidateSet('txt', 'md', 'srt')][string]$Format)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The $Format native-dialog export is missing."
  }
  $content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  if ([regex]::Matches($content, [regex]::Escape($FixtureText)).Count -ne 1) {
    throw "The $Format export does not contain exactly the selected fixture segment."
  }
  $recordCount = switch ($Format) {
    'txt' { @([regex]::Split($content.TrimEnd(), '\r?\n')).Count }
    'md' { [regex]::Matches($content, '(?m)^- ').Count }
    'srt' { [regex]::Matches($content, '(?m)^\d+\r?$').Count }
  }
  if ($recordCount -ne 1) { throw "The $Format export contains $recordCount records instead of one." }
  return [pscustomobject][ordered]@{
    bytes = (Get-Item -LiteralPath $Path).Length
    recordCount = 1
    sha256 = Get-Sha256 $Path
  }
}

function Assert-ExportSetsMatch {
  param([object]$Before, [object]$After)
  foreach ($format in @('text', 'markdown', 'srt')) {
    if ($Before.$format.bytes -ne $After.$format.bytes -or
        $Before.$format.sha256 -cne $After.$format.sha256) {
      throw "The reinstalled app produced a different $format export."
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
  throw 'I4 non-audio qualification requires Windows 11 build 22000 or newer.'
}
if (-not [Environment]::UserInteractive) { throw 'An interactive desktop is required.' }
if (-not $AttestCleanWindowsSnapshot -or -not $AttestCleanUserProfile -or
    -not $AttestDedicatedStandardUser) {
  throw 'All clean-machine and dedicated-standard-user attestations are required.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run from a non-elevated dedicated standard-user account.'
}
if ($null -ne (Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'Node.js must not be available in the dedicated qualification account.'
}

$InstallerPath = Get-AbsoluteExistingFile $Installer 'Installer'
$B5LayoutPath = Get-AbsoluteExistingFile $B5LayoutEvidence 'B5 layout evidence'
$LegacyFixturePath = Get-AbsoluteExistingFile $LegacyFixture 'Legacy fixture'
$ExportRootPath = Get-AbsolutePath $ExportRoot
$ReportPath = Get-AbsolutePath $Report
if (Test-Path -LiteralPath $ExportRootPath) { throw 'ExportRoot must not already exist.' }
if (Test-Path -LiteralPath $ReportPath) { throw 'Report must not already exist.' }
foreach ($probe in @($PSScriptRoot, $InstallerPath, $B5LayoutPath, $LegacyFixturePath, (Get-Location).Path)) {
  if (Test-HasGitAncestor $probe) { throw 'All qualification inputs must execute outside a Git repository.' }
}

$B5LayoutEvidenceSha256 = Get-Sha256 $B5LayoutPath
$B5Layout = Get-Content -LiteralPath $B5LayoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-B5LayoutEvidence $B5Layout
$InstallerSha256 = Get-Sha256 $InstallerPath
if ($InstallerSha256 -cne $B5Layout.artifact.installerSha256) {
  throw 'Installer SHA-256 does not match the supplied B5 layout evidence.'
}
$FixtureSha256 = Get-Sha256 $LegacyFixturePath
$signature = (Get-AuthenticodeSignature -LiteralPath $InstallerPath).Status.ToString()
$SigningStatus = if ($signature -ceq 'NotSigned') { 'not-signed' } elseif ($signature -ceq 'Valid') { 'valid' } else {
  throw "Installer Authenticode status is $signature."
}
if ($SigningStatus -cne $B5Layout.artifact.signingStatus) {
  throw 'Installer signing status differs from B5 layout evidence.'
}

$RoamingRoot = [Environment]::GetFolderPath('ApplicationData')
$LocalRoot = [Environment]::GetFolderPath('LocalApplicationData')
$ProgramsRoot = Join-Path $LocalRoot 'Programs'
if ([string]::IsNullOrWhiteSpace($RoamingRoot) -or [string]::IsNullOrWhiteSpace($LocalRoot)) {
  throw 'Windows Known Folder lookup failed.'
}
foreach ($name in @($ExpectedUserDataName, 'Live Subtitle', 'com.live-subtitle.desktop')) {
  if ((Test-Path -LiteralPath (Join-Path $RoamingRoot $name)) -or
      (Test-Path -LiteralPath (Join-Path $LocalRoot $name))) {
    throw "Prior application data exists for $name."
  }
}
if ((Test-Path -LiteralPath $ProgramsRoot) -and
    @(Get-ChildItem -LiteralPath $ProgramsRoot -Filter 'LiveSubtitle.exe' -File -Recurse).Count -ne 0) {
  throw 'A prior LiveSubtitle installation exists in the user profile.'
}
$RoamingBefore = Get-TopLevelDirectorySet $RoamingRoot
$reportParent = Split-Path -Parent $ReportPath
if (-not (Test-Path -LiteralPath $reportParent -PathType Container)) {
  New-Item -ItemType Directory -Path $reportParent | Out-Null
}
New-Item -ItemType Directory -Path $ExportRootPath | Out-Null

Write-Host 'Launching the exact one-click NSIS installer without silent flags.'
$installProcess = Start-Process -FilePath $InstallerPath -PassThru -Wait
if ($installProcess.ExitCode -ne 0) { throw "NSIS install exited with code $($installProcess.ExitCode)." }
$InstalledExecutable = Get-InstalledExecutable $ProgramsRoot
$InstallDirectory = Split-Path -Parent $InstalledExecutable
$InstalledIdentity = Assert-InstalledFilesMatchB5 $InstalledExecutable $B5Layout

Assert-AllDownloadHostsReachable
Write-Host @"
The B5-bound installed release will start now.
1. Confirm the interactive NSIS install was visible and completed.
2. Complete onboarding without pressing Start.
3. In Settings > Model resources, use the normal core Download action over public HTTPS.
4. Wait for realtime ASR and VAD to show core Ready.
5. Attempt to enable refinement while its resource is missing. It must stay disabled and
   present its explicit download action. Do not download refinement in this launch.
6. Confirm no media-permission prompt appeared and no audio played.
7. Close the application normally, then enter the token.
"@
$firstProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation 'FIRST-LAUNCH-NO-CAPTURE' 'Type FIRST-LAUNCH-NO-CAPTURE after the normal close'
Wait-ExactApplicationExit $firstProcess $InstalledExecutable

$UserData = Find-NewUserDataDirectory $RoamingRoot $RoamingBefore
$ConfigPath = Join-Path $UserData 'config.json'
$DatabasePath = Join-Path $UserData 'data\speech-agent.sqlite3'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'The product config was not written.' }
Assert-SqliteHeader $DatabasePath
$CoreReadyMarkers = @(Get-ReadyMarkerEvidence $UserData $CoreModels)
if (($CoreReadyMarkers | Measure-Object -Property bytes -Sum).Sum -ne $ExpectedCoreDownloadedBytes) {
  throw 'Ready markers do not describe exactly the core resource group.'
}
$CoreModelFilePaths = @(Get-ModelFilePaths $UserData $CoreModels)
if ($CoreModelFilePaths.Count -ne $ExpectedCoreModelFileCount) { throw 'Unexpected core model file count.' }
if (Get-RefinementPreference $ConfigPath) {
  throw 'The missing refinement resource unexpectedly enabled the global preference.'
}

Assert-AllDownloadHostsReachable
Write-Host @"
The B5-bound installed release will start again without capture.
1. In Settings > Model resources, explicitly choose the refinement Download action over public HTTPS.
2. Wait for the refinement resource to show Ready. Its preference must remain disabled.
3. Do not press Start; confirm no media-permission prompt or sound appears.
4. Close normally, then enter the token.
"@
$refinementDownloadProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation 'REFINEMENT-DOWNLOAD-READY-NO-CAPTURE' 'Type REFINEMENT-DOWNLOAD-READY-NO-CAPTURE after the normal close'
Wait-ExactApplicationExit $refinementDownloadProcess $InstalledExecutable

$AllReadyMarkers = @(Get-ReadyMarkerEvidence $UserData)
$ModelFilePaths = @(Get-ModelFilePaths $UserData)
if ($ModelFilePaths.Count -ne $ExpectedModelFileCount) { throw 'Unexpected installed resource file count.' }
if (Get-RefinementPreference $ConfigPath) {
  throw 'Refinement readiness unexpectedly enabled the global preference.'
}

Write-Host @"
The B5-bound installed release will start once more without capture.
1. In Settings, explicitly enable the ready refinement preference.
2. Do not press Start; confirm no media-permission prompt or sound appears.
3. Close normally, then enter the token.
"@
$refinementPreferenceProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation 'REFINEMENT-PREFERENCE-ENABLED-NO-CAPTURE' 'Type REFINEMENT-PREFERENCE-ENABLED-NO-CAPTURE after the normal close'
Wait-ExactApplicationExit $refinementPreferenceProcess $InstalledExecutable
if (-not (Get-RefinementPreference $ConfigPath)) {
  throw 'The explicit refinement preference action did not persist as enabled.'
}

$SessionsDirectory = Join-Path $UserData 'sessions'
if (-not (Test-Path -LiteralPath $SessionsDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $SessionsDirectory | Out-Null
}
$LegacyTarget = Join-Path $SessionsDirectory 'i4-nonaudio-legacy-session.jsonl'
if (Test-Path -LiteralPath $LegacyTarget) { throw 'The legacy fixture target unexpectedly exists.' }
Copy-Item -LiteralPath $LegacyFixturePath -Destination $LegacyTarget
if ((Get-Sha256 $LegacyTarget) -cne $FixtureSha256) { throw 'Legacy fixture changed while being seeded.' }

Write-Host @"
Use the declared external control now: $OfflineControl.
A standard user is not expected to disable adapters. Disconnect the VM vNIC
from the host, or use a preconfigured administrator-owned outbound block.
Enter NETWORK-OFF only after all external network access is unavailable.
"@
Assert-Confirmation 'NETWORK-OFF' 'Type NETWORK-OFF after external network isolation'
Assert-AllDownloadHostsUnreachable 'offline restart'

$TxtExport = Join-Path $ExportRootPath 'i4-nonaudio-history.txt'
$MarkdownExport = Join-Path $ExportRootPath 'i4-nonaudio-history.md'
$SrtExport = Join-Path $ExportRootPath 'i4-nonaudio-history.srt'
Write-Host @"
The B5-bound installed release will restart while all model download hosts are unreachable.
1. Confirm the core and separately ready refinement resource remain Ready, and the explicitly
   enabled global refinement preference remains enabled.
2. Open History and confirm exactly ONE i4-nonaudio-legacy-session entry exists.
3. Select it and use each real Save dialog to save exactly to:
   $TxtExport
   $MarkdownExport
   $SrtExport
4. Do not press Start; confirm no media-permission prompt or sound appears.
5. Close normally, then enter the token.
"@
$offlineProcess = Start-Process -FilePath $InstalledExecutable -PassThru
Assert-Confirmation 'OFFLINE-EXPORTS-NO-CAPTURE' 'Type OFFLINE-EXPORTS-NO-CAPTURE after the three exports and normal close'
Wait-ExactApplicationExit $offlineProcess $InstalledExecutable

$Exports = [pscustomobject][ordered]@{
  text = Get-ExportEvidence $TxtExport 'txt'
  markdown = Get-ExportEvidence $MarkdownExport 'md'
  srt = Get-ExportEvidence $SrtExport 'srt'
}
if ((Get-Sha256 $LegacyTarget) -cne $FixtureSha256) { throw 'Legacy source changed during migration.' }
Assert-SqliteHeader $DatabasePath
$OfflineReadyMarkers = @(Get-ReadyMarkerEvidence $UserData)
if (-not (Get-RefinementPreference $ConfigPath)) {
  throw 'The enabled refinement preference did not survive the offline restart.'
}
$MarkerPaths = @(
  Get-ChildItem -LiteralPath (Join-Path $UserData 'models') -Filter '.ready.json' -File -Recurse -Force |
    Select-Object -ExpandProperty FullName
)
$PreservationPaths = @($ConfigPath, $DatabasePath, $LegacyTarget) + $MarkerPaths + $ModelFilePaths
$ManifestBefore = Get-PreservationManifest $UserData $PreservationPaths
if ($ManifestBefore.entryCount -ne $ExpectedPreservationEntryCount) {
  throw "The preservation manifest must contain $ExpectedPreservationEntryCount selected files."
}

$uninstallers = @(Get-ChildItem -LiteralPath $InstallDirectory -Filter 'Uninstall*.exe' -File)
if ($uninstallers.Count -ne 1) { throw 'The exact installed NSIS uninstaller could not be identified.' }
Write-Host 'Launching the generated uninstaller interactively.'
$uninstallProcess = Start-Process -FilePath $uninstallers[0].FullName -PassThru -Wait
if ($uninstallProcess.ExitCode -ne 0) { throw "NSIS uninstall exited with code $($uninstallProcess.ExitCode)." }
Assert-Confirmation 'UNINSTALL-OBSERVED' 'Type UNINSTALL-OBSERVED after observing the uninstall complete'
Wait-PathAbsent $InstallDirectory
$ManifestAfterUninstall = Get-PreservationManifest $UserData $PreservationPaths
if ($ManifestAfterUninstall.sha256 -cne $ManifestBefore.sha256) {
  throw 'Selected product data changed during uninstall.'
}
Assert-AllDownloadHostsUnreachable 'offline reinstall'

Write-Host 'Reinstalling the same exact NSIS candidate interactively while download hosts remain unreachable.'
$reinstallProcess = Start-Process -FilePath $InstallerPath -PassThru -Wait
if ($reinstallProcess.ExitCode -ne 0) { throw "NSIS reinstall exited with code $($reinstallProcess.ExitCode)." }
$ReinstalledExecutable = Get-InstalledExecutable $ProgramsRoot
$ReinstalledIdentity = Assert-InstalledFilesMatchB5 $ReinstalledExecutable $B5Layout

$ReinstallTxtExport = Join-Path $ExportRootPath 'reinstall-i4-nonaudio-history.txt'
$ReinstallMarkdownExport = Join-Path $ExportRootPath 'reinstall-i4-nonaudio-history.md'
$ReinstallSrtExport = Join-Path $ExportRootPath 'reinstall-i4-nonaudio-history.srt'
Write-Host @"
The reinstalled B5-bound release will start offline.
1. Confirm core and refinement resources are Ready without downloading, and the enabled global
   refinement preference is preserved.
2. Confirm exactly ONE i4-nonaudio-legacy-session entry exists in History.
3. Select it and export again through all three native Save dialogs to:
   $ReinstallTxtExport
   $ReinstallMarkdownExport
   $ReinstallSrtExport
4. Do not press Start; confirm no permission prompt or sound appears.
5. Close normally, then enter the token.
"@
$reinstallAppProcess = Start-Process -FilePath $ReinstalledExecutable -PassThru
Assert-Confirmation 'REINSTALL-READY-NO-CAPTURE' 'Type REINSTALL-READY-NO-CAPTURE after the three exports and normal close'
Wait-ExactApplicationExit $reinstallAppProcess $ReinstalledExecutable

$ReinstallExports = [pscustomobject][ordered]@{
  text = Get-ExportEvidence $ReinstallTxtExport 'txt'
  markdown = Get-ExportEvidence $ReinstallMarkdownExport 'md'
  srt = Get-ExportEvidence $ReinstallSrtExport 'srt'
}
Assert-ExportSetsMatch $Exports $ReinstallExports
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $DatabasePath -PathType Leaf) -or
    (Get-Sha256 $LegacyTarget) -cne $FixtureSha256) {
  throw 'Selected product data was not reusable after reinstall.'
}
Assert-SqliteHeader $DatabasePath
$ReinstallReadyMarkers = @(Get-ReadyMarkerEvidence $UserData)
if (-not (Get-RefinementPreference $ConfigPath)) {
  throw 'The enabled refinement preference was not preserved through reinstall.'
}
$ManifestAfterReinstall = Get-PreservationManifest $UserData $PreservationPaths
if ($ManifestAfterReinstall.sha256 -cne $ManifestBefore.sha256) {
  throw 'Selected product data changed during offline reinstall/reuse.'
}
$Privacy = Get-AudioPrivacyCounts @($UserData, $ExportRootPath)
if ($Privacy.audioFileCount -ne 0 -or $Privacy.persistedAudioReferenceCount -ne 0) {
  throw 'The no-capture journey left an audio file or persisted audio reference.'
}

$qualification = [pscustomobject][ordered]@{
  schemaVersion = 3
  kind = 'i4-nonaudio-nsis-qualification'
  generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  result = 'pass'
  gateStatus = 'partial'
  environment = [pscustomobject][ordered]@{
    osFamily = 'windows'
    osBuild = [Environment]::OSVersion.Version.Build
    operatorAttestedDedicatedStandardUser = $true
    operatorAttestedCleanWindowsSnapshot = $true
    operatorAttestedCleanUserProfile = $true
    harnessVerifiedRepositoryAncestorsAbsent = $true
    harnessVerifiedNodeCommandAbsent = $true
    harnessVerifiedPriorKnownApplicationDataAbsent = $true
    harnessVerifiedPriorKnownProductModelsAbsent = $true
    harnessVerifiedInteractiveDesktop = $true
    harnessVerifiedNonElevated = $true
  }
  artifact = [pscustomobject][ordered]@{
    b5LayoutEvidenceSha256 = $B5LayoutEvidenceSha256
    installerTarget = 'nsis'
    arch = 'x64'
    installerSha256 = $InstallerSha256
    installedExecutableSha256 = $InstalledIdentity.executableSha256
    installedAsarSha256 = $InstalledIdentity.asarSha256
    reinstalledExecutableSha256 = $ReinstalledIdentity.executableSha256
    reinstalledAsarSha256 = $ReinstalledIdentity.asarSha256
    productPayloadVersion = $B5Layout.artifact.productPayloadVersion
    productPayloadFileCount = [int]$B5Layout.artifact.productPayloadFileCount
    productPayloadSha256 = $B5Layout.artifact.productPayloadSha256
    productPayloadIdentitySource = 'tracked-b5-layout-installed-asar-binding'
    installedViaNsis = $true
    releaseMain = $B5Layout.artifact.mainEntry
    signingStatus = $SigningStatus
    exactCandidateBound = $true
  }
  firstLaunch = [pscustomobject][ordered]@{
    harnessLaunchedBoundReleaseExecutable = $true
    operatorAttestedInteractiveInstall = $true
    harnessVerifiedCoreReadyMarkers = $true
    harnessVerifiedCoreModelFilesPresent = $true
    harnessVerifiedRefinementReadyMarkersAbsent = $true
    harnessVerifiedRefinementModelFilesAbsent = $true
    refinementPreferenceInitiallyDisabled = $true
    operatorAttestedMissingRefinementPreferenceAttempted = $true
    operatorAttestedMissingRefinementPreferenceStayedDisabled = $true
    harnessVerifiedRefinementPreferenceDisabled = $true
    operatorAttestedPublicHttpsCoreDownloadFromSettings = $true
    downloadHostReachabilityVerified = $true
    modelTransportEvidence = 'operator-attested-settings-public-https'
    manifestAllowedDownloadHosts = $ManifestAllowedDownloadHosts
    coreDownloadedBytesFromReadyMarkers = [int64]$ExpectedCoreDownloadedBytes
    coreReadyMarkerCount = $CoreReadyMarkers.Count
    coreModelArtifactCount = $CoreModels.Count
    coreModelFileCount = $CoreModelFilePaths.Count
    refinementReadyMarkerCount = 0
    refinementModelFileCount = 0
    refinementNetworkAttemptCountAssessed = $false
    harnessVerifiedStagingClean = $true
    operatorAttestedRuntimeCoreReadyBeforeCapture = $true
    operatorAttestedNoCaptureCommand = $true
    operatorAttestedNoMediaPermissionPrompt = $true
    harnessObservedNormalExit = $true
  }
  refinementSetup = [pscustomobject][ordered]@{
    harnessLaunchedBoundReleaseExecutable = $true
    harnessObservedRefinementDownloadNormalExit = $true
    harnessObservedPreferenceEnableNormalExit = $true
    operatorAttestedPublicHttpsRefinementDownloadFromSettings = $true
    downloadHostReachabilityVerified = $true
    modelTransportEvidence = 'operator-attested-settings-public-https'
    manifestAllowedDownloadHosts = $ManifestAllowedDownloadHosts
    harnessVerifiedCoreReadyMarkers = $true
    harnessVerifiedRefinementReadyMarkers = $true
    harnessVerifiedRefinementModelFilesPresent = $true
    harnessVerifiedStagingClean = $true
    refinementDownloadedBytesFromReadyMarkers = [int64]$ExpectedRefinementDownloadedBytes
    refinementReadyMarkerCount = $RefinementModels.Count
    refinementModelArtifactCount = $RefinementModels.Count
    refinementModelFileCount = $ExpectedRefinementModelFileCount
    operatorAttestedRefinementPreferenceStayedDisabledAfterDownload = $true
    harnessVerifiedRefinementPreferenceDisabledAfterDownload = $true
    operatorAttestedRefinementPreferenceExplicitlyEnabled = $true
    harnessVerifiedRefinementPreferenceEnabled = $true
    operatorAttestedNoCaptureCommand = $true
    operatorAttestedNoMediaPermissionPrompt = $true
  }
  offlineRestart = [pscustomobject][ordered]@{
    downloadHostsUnreachableAtRestart = $true
    offlineControl = $OfflineControl
    networkAttemptCountAssessed = $false
    harnessLaunchedBoundReleaseExecutable = $true
    operatorAttestedCoreReady = $true
    operatorAttestedRefinementReady = $true
    operatorAttestedRefinementPreferenceEnabledAfterRestart = $true
    harnessVerifiedRefinementPreferencePersisted = $true
    coreReadyMarkerCount = $CoreModels.Count
    refinementReadyMarkerCount = $RefinementModels.Count
    operatorAttestedLegacySessionCount = 1
    operatorAttestedNativeSaveDialogs = $true
    exportFormats = @('txt', 'md', 'srt')
    exportArtifactCount = 3
    exportedSegmentCount = 1
    harnessVerifiedExports = $true
    operatorAttestedNoCaptureCommand = $true
    operatorAttestedNoMediaPermissionPrompt = $true
    harnessObservedNormalExit = $true
  }
  dataLifecycle = [pscustomobject][ordered]@{
    userDataDirectoryName = (Split-Path -Leaf $UserData)
    userDataDiscovery = 'new-roaming-directory-with-product-data'
    configPresent = $true
    sqliteHeaderValid = $true
    legacyFixtureSha256 = $FixtureSha256
    legacySourceUnchanged = $true
    readyMarkers = $ReinstallReadyMarkers
    coreReadyMarkerCount = $CoreModels.Count
    refinementReadyMarkerCount = $RefinementModels.Count
    modelFileCount = $ExpectedModelFileCount
    applicationDataWritten = $true
    preservationScope = 'config-sqlite-legacy-ready-markers-and-model-files'
    preservationManifestEntryCount = $ManifestBefore.entryCount
    preservationManifestSha256BeforeUninstall = $ManifestBefore.sha256
    preservationManifestSha256AfterUninstall = $ManifestAfterUninstall.sha256
    selectedApplicationDataPreservedAfterUninstall = $true
    operatorAttestedInteractiveUninstall = $true
    uninstallExitCode = 0
    installDirectoryRemoved = $true
    downloadHostsUnreachableAtReinstall = $true
    operatorAttestedInteractiveReinstall = $true
    reinstallExitCode = 0
    operatorAttestedCoreReadyAfterReinstall = $true
    operatorAttestedRefinementReadyAfterReinstall = $true
    operatorAttestedRefinementPreferenceEnabledAfterReinstall = $true
    harnessVerifiedRefinementPreferencePreservedAfterReinstall = $true
    operatorAttestedLegacySessionCountAfterReinstall = 1
    harnessVerifiedSelectedDataPresentAfterReinstall = $true
    preservationManifestSha256AfterReinstall = $ManifestAfterReinstall.sha256
    preservationManifestUnchangedThroughReinstall = $true
    harnessObservedReinstallNormalExit = $true
    harnessVerifiedReinstallExportsMatch = $true
    exports = $Exports
    reinstallExports = $ReinstallExports
  }
  privacy = [pscustomobject][ordered]@{
    operatorAttestedNoPhysicalAudioSource = $true
    operatorAttestedNoCaptureCommand = $true
    operatorAttestedNoSpeakerPlayback = $true
    harnessAudioFileCount = 0
    harnessPersistedAudioReferenceCount = 0
    reportContainsTranscriptText = $false
    reportContainsAbsolutePath = $false
    reportContainsSensitiveNetworkData = $false
  }
  limitations = @(
    'no-physical-audio',
    'no-media-permission-acceptance',
    'no-real-asr-inference',
    'no-active-session-preference-freeze',
    'no-per-process-network-attempt-audit',
    'operator-driven-windows-ui',
    'unsigned-installer',
    'i4-full-status-partial'
  )
}

$json = $qualification | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($ReportPath, $json + "`n", [Text.UTF8Encoding]::new($false))
Write-Host 'I4 non-audio pass/partial report written. Full I4 remains open for audio and permission acceptance.'
