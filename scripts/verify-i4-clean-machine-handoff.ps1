param(
  [string]$BundleRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Names,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join "`n") -cne ($expected -join "`n")) {
    throw "$Label has unexpected fields."
  }
}

function Assert-Sha256 {
  param([string]$Value, [string]$Label)
  if ($Value -cnotmatch '^[a-f0-9]{64}$') {
    throw "$Label is not a lowercase SHA-256 digest."
  }
}

$root = [System.IO.Path]::GetFullPath($BundleRoot)
$manifestPath = Join-Path $root 'handoff-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'handoff-manifest.json is missing.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ExactProperties $manifest @(
  'artifact', 'constraints', 'files', 'generatedAt', 'kind', 'limitations',
  'privacy', 'result', 'schemaVersion'
) 'handoff manifest'
if ($manifest.schemaVersion -ne 1 -or $manifest.kind -cne 'i4-clean-machine-handoff' -or
    $manifest.result -cne 'pass') {
  throw 'Invalid handoff manifest envelope.'
}

Assert-ExactProperties $manifest.artifact @(
  'b5LayoutEvidenceSha256', 'exactCandidateBound', 'installerSha256',
  'productPayloadFileCount', 'productPayloadSha256', 'productPayloadVersion'
) 'artifact'
Assert-Sha256 $manifest.artifact.b5LayoutEvidenceSha256 'artifact.b5LayoutEvidenceSha256'
Assert-Sha256 $manifest.artifact.installerSha256 'artifact.installerSha256'
Assert-Sha256 $manifest.artifact.productPayloadSha256 'artifact.productPayloadSha256'
if ($manifest.artifact.exactCandidateBound -ne $true) {
  throw 'The handoff is not bound to the exact candidate.'
}

Assert-ExactProperties $manifest.constraints @(
  'entryCount', 'extraEntryCount', 'nodeRuntimeIncluded', 'repositoryTreeIncluded'
) 'constraints'
if ($manifest.constraints.entryCount -ne 6 -or $manifest.constraints.extraEntryCount -ne 0 -or
    $manifest.constraints.nodeRuntimeIncluded -ne $false -or
    $manifest.constraints.repositoryTreeIncluded -ne $false) {
  throw 'The handoff constraints are not closed.'
}

$ExpectedLegacyFixtureSha256 = '7877d33c271546b2e3171814abb0b86b1bf8593ff2a7b96e138d17893a4ea348'
Assert-ExactProperties $manifest.privacy @(
  'capturedAudioFileCount', 'capturedOrReportTranscriptTextIncluded',
  'containsAbsolutePath', 'containsDeviceName', 'fixedSyntheticLegacyFixtureIncluded',
  'fixedSyntheticLegacyFixtureSha256'
) 'privacy'
Assert-Sha256 $manifest.privacy.fixedSyntheticLegacyFixtureSha256 'privacy.fixedSyntheticLegacyFixtureSha256'
if ($manifest.privacy.capturedAudioFileCount -ne 0 -or
    $manifest.privacy.capturedOrReportTranscriptTextIncluded -ne $false -or
    $manifest.privacy.containsAbsolutePath -ne $false -or
    $manifest.privacy.containsDeviceName -ne $false -or
    $manifest.privacy.fixedSyntheticLegacyFixtureIncluded -ne $true -or
    $manifest.privacy.fixedSyntheticLegacyFixtureSha256 -cne $ExpectedLegacyFixtureSha256) {
  throw 'The handoff violates the SEM-F14 privacy boundary.'
}

$expectedLimitations = @(
  'unsigned-installer',
  'fixed-synthetic-legacy-fixture-included',
  'clean-machine-execution-not-yet-run'
)
if ((@($manifest.limitations) -join "`n") -cne ($expectedLimitations -join "`n")) {
  throw 'The handoff limitations are incomplete.'
}

$manifestFiles = @{}
foreach ($entry in @($manifest.files)) {
  Assert-ExactProperties $entry @('bytes', 'relativePath', 'role', 'sha256') 'files entry'
  if ($entry.relativePath -notmatch '^[a-z0-9][a-z0-9._/-]*$' -or
      $entry.relativePath.Contains('..') -or $entry.relativePath.Contains('\')) {
    throw 'A handoff relative path is unsafe.'
  }
  if ($manifestFiles.ContainsKey($entry.relativePath)) {
    throw 'The handoff manifest contains a duplicate relative path.'
  }
  Assert-Sha256 $entry.sha256 "files.$($entry.relativePath).sha256"
  if ($entry.bytes -lt 1) {
    throw 'A handoff file is empty.'
  }
  $manifestFiles[$entry.relativePath] = $entry
}
if ($manifestFiles.Count -ne 6) {
  throw 'The handoff manifest must bind exactly six payload files.'
}
$expectedFixedRoles = @{
  'evidence/b5-packaged-layout-results.json' = 'b5-layout'
  'fixtures/i4-nonaudio-legacy-session.jsonl' = 'legacy-fixture'
  'runners/qualify-i4-audio-child.ps1' = 'audio-runner'
  'runners/qualify-i4-nonaudio-nsis.ps1' = 'non-audio-runner'
  'verifiers/verify-i4-clean-machine-handoff.ps1' = 'handoff-verifier'
}
$installerEntries = @($manifest.files | Where-Object { $_.role -ceq 'installer' })
if ($installerEntries.Count -ne 1 -or
    [string]$installerEntries[0].relativePath -cnotmatch '^installer/Live-Subtitle-[0-9A-Za-z._-]+-x64\.exe$') {
  throw 'The handoff must contain one versioned x64 installer.'
}
foreach ($relative in $expectedFixedRoles.Keys) {
  if (-not $manifestFiles.ContainsKey($relative) -or
      [string]$manifestFiles[$relative].role -cne $expectedFixedRoles[$relative]) {
    throw 'The handoff path-to-role allowlist is incomplete.'
  }
}
foreach ($entry in @($manifest.files)) {
  if ($entry.role -ceq 'installer') { continue }
  if (-not $expectedFixedRoles.ContainsKey([string]$entry.relativePath) -or
      $expectedFixedRoles[[string]$entry.relativePath] -cne [string]$entry.role) {
    throw 'The handoff contains an unexpected path or role.'
  }
}

$actualFiles = @{}
$actualDirectories = @()
foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Recurse -Force)) {
  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Reparse points are forbidden in the handoff.'
  }
  $rootPrefix = $root.TrimEnd('\') + '\'
  if (-not $directory.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'A handoff directory escaped the bundle root.'
  }
  $actualDirectories += $directory.FullName.Substring($rootPrefix.Length).Replace('\', '/')
}
$expectedDirectories = @('evidence', 'fixtures', 'installer', 'runners', 'verifiers')
if ((@($actualDirectories | Sort-Object) -join "`n") -cne ($expectedDirectories -join "`n")) {
  throw 'The handoff contains missing or extra directories.'
}
foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force)) {
  if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Reparse points are forbidden in the handoff.'
  }
  $rootPrefix = $root.TrimEnd('\') + '\'
  if (-not $file.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'A handoff file escaped the bundle root.'
  }
  $relative = $file.FullName.Substring($rootPrefix.Length).Replace('\', '/')
  $actualFiles[$relative] = $file.FullName
}
$expectedPaths = @($manifestFiles.Keys) + @('handoff-manifest.json')
if ((@($actualFiles.Keys | Sort-Object) -join "`n") -cne (@($expectedPaths | Sort-Object) -join "`n")) {
  throw 'The handoff contains missing or extra files.'
}
foreach ($relative in $manifestFiles.Keys) {
  $entry = $manifestFiles[$relative]
  $item = Get-Item -LiteralPath $actualFiles[$relative]
  if ($item.Length -ne $entry.bytes) {
    throw "Byte count mismatch for $relative."
  }
  $digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -cne $entry.sha256) {
    throw "SHA-256 mismatch for $relative."
  }
}

$forbidden = @($actualFiles.Keys | Where-Object {
  $_ -match '(^|/)(?:\.git|node_modules)(?:/|$)' -or
  $_ -match '(^|/)(?:node|npm|npx)(?:\.exe|\.cmd)?$' -or
  $_ -match '(^|/)(?:AGENTS\.md|CONTEXT\.md|package\.json|package-lock\.json)$'
})
if ($forbidden.Count -ne 0) {
  throw 'The handoff contains a repository or Node runtime entry.'
}

$layoutEntry = $manifestFiles['evidence/b5-packaged-layout-results.json']
$installerEntry = $installerEntries
if ($null -eq $layoutEntry -or $installerEntry.Count -ne 1) {
  throw 'The handoff must contain one B5 layout and one installer.'
}
$layout = Get-Content -LiteralPath $actualFiles['evidence/b5-packaged-layout-results.json'] -Raw -Encoding UTF8 | ConvertFrom-Json
if ($layout.artifact.installerSha256 -cne $manifest.artifact.installerSha256 -or
    $installerEntry[0].sha256 -cne $manifest.artifact.installerSha256 -or
    $layoutEntry.sha256 -cne $manifest.artifact.b5LayoutEvidenceSha256 -or
    $manifestFiles['fixtures/i4-nonaudio-legacy-session.jsonl'].sha256 -cne $ExpectedLegacyFixtureSha256 -or
    $manifestFiles['fixtures/i4-nonaudio-legacy-session.jsonl'].sha256 -cne
      $manifest.privacy.fixedSyntheticLegacyFixtureSha256 -or
    $layout.artifact.productPayloadVersion -cne $manifest.artifact.productPayloadVersion -or
    $layout.artifact.productPayloadFileCount -ne $manifest.artifact.productPayloadFileCount -or
    $layout.artifact.productPayloadSha256 -cne $manifest.artifact.productPayloadSha256) {
  throw 'The handoff candidate binding differs from the B5 layout.'
}

Write-Output 'I4 clean-machine handoff verified.'
