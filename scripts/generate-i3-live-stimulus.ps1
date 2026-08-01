[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\models\i3-live-audio-stimulus')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
  Generates the short, repeatable I3 speech fixture without text-to-speech,
  playback, or capture. It copies a pinned 1,000 ms PCM16 prefix from the
  Gate 0B controlled corpus and appends fixed digital silence.
#>

function Get-WavPcm16MonoData {
  param([byte[]]$Bytes)

  if ($Bytes.Length -lt 44 -or [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -ne 'RIFF' -or
      [Text.Encoding]::ASCII.GetString($Bytes, 8, 4) -ne 'WAVE') {
    throw 'Controlled corpus is not a RIFF/WAVE file.'
  }
  $offset = 12
  $format = $null
  $pcm = $null
  while ($offset + 8 -le $Bytes.Length) {
    $chunkId = [Text.Encoding]::ASCII.GetString($Bytes, $offset, 4)
    $chunkSize = [BitConverter]::ToUInt32($Bytes, $offset + 4)
    $chunkEnd = [int64]$offset + 8 + [int64]$chunkSize
    if ($chunkEnd -gt $Bytes.Length) { throw "WAV chunk $chunkId exceeds the file length." }
    if ($chunkId -eq 'fmt ') {
      if ($chunkSize -lt 16) { throw 'WAV fmt chunk is too small.' }
      $format = [ordered]@{
        audioFormat = [BitConverter]::ToUInt16($Bytes, $offset + 8)
        channels = [BitConverter]::ToUInt16($Bytes, $offset + 10)
        sampleRate = [BitConverter]::ToUInt32($Bytes, $offset + 12)
        bitsPerSample = [BitConverter]::ToUInt16($Bytes, $offset + 22)
      }
    } elseif ($chunkId -eq 'data') {
      $pcm = New-Object byte[] $chunkSize
      [Buffer]::BlockCopy($Bytes, $offset + 8, $pcm, 0, $chunkSize)
    }
    $offset = [int]($chunkEnd + ($chunkSize % 2))
  }
  if ($null -eq $format -or $null -eq $pcm) { throw 'Controlled corpus WAV is missing fmt or data.' }
  return [ordered]@{ format = $format; pcm = $pcm }
}

$definitionPath = Join-Path $PSScriptRoot 'i3-live-stimulus.json'
$definition = Get-Content -Raw -Encoding UTF8 -LiteralPath $definitionPath | ConvertFrom-Json
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot (Join-Path 'models\gate-0b\corpus' ([string]$definition.sourceCorpus.file))
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$wavPath = Join-Path $outputPath ($definition.id + '.wav')
$metadataPath = Join-Path $outputPath 'metadata.json'

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Controlled source corpus is missing: $sourcePath" }
$sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
if ($sourceSha256 -ne [string]$definition.sourceCorpus.sha256) { throw 'Controlled source corpus SHA-256 does not match the tracked definition.' }

$source = Get-WavPcm16MonoData ([System.IO.File]::ReadAllBytes($sourcePath))
if ($source.format.audioFormat -ne 1 -or $source.format.channels -ne [int]$definition.channels -or
    $source.format.sampleRate -ne [int]$definition.sampleRate -or $source.format.bitsPerSample -ne [int]$definition.bitsPerSample) {
  throw 'Controlled source corpus format does not match the tracked PCM16 mono definition.'
}

$bytesPerSample = [int]$definition.bitsPerSample / 8 * [int]$definition.channels
$sliceStartSamples = [int]($definition.sliceStartMs * $definition.sampleRate / 1000)
$sliceSampleCount = [int]($definition.sliceLengthMs * $definition.sampleRate / 1000)
$sliceStartBytes = $sliceStartSamples * $bytesPerSample
$sliceByteLength = $sliceSampleCount * $bytesPerSample
if ($sliceStartBytes -lt 0 -or $sliceByteLength -le 0 -or $sliceStartBytes + $sliceByteLength -gt $source.pcm.Length) {
  throw 'Tracked corpus slice is outside the controlled source WAV.'
}
$silenceSampleCount = [int]($definition.silenceDurationMs * $definition.sampleRate / 1000)
$silenceBytes = $silenceSampleCount * $bytesPerSample
$combined = New-Object byte[] ($sliceByteLength + $silenceBytes)
[Buffer]::BlockCopy($source.pcm, $sliceStartBytes, $combined, 0, $sliceByteLength)

$cycleDurationMs = [int](($combined.Length / $bytesPerSample / [int]$definition.sampleRate) * 1000)
if ($cycleDurationMs -gt [int]$definition.maximumCycleDurationMs) {
  throw "Generated I3 cycle $cycleDurationMs ms exceeds the tracked maximum $($definition.maximumCycleDurationMs) ms."
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$writer = [System.IO.BinaryWriter]::new([System.IO.File]::Open($wavPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write))
try {
  $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF'))
  $writer.Write([int](36 + $combined.Length))
  $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
  $writer.Write([int]16)
  $writer.Write([int16]1)
  $writer.Write([int16]$definition.channels)
  $writer.Write([int]$definition.sampleRate)
  $writer.Write([int]($definition.sampleRate * $bytesPerSample))
  $writer.Write([int16]$bytesPerSample)
  $writer.Write([int16]$definition.bitsPerSample)
  $writer.Write([Text.Encoding]::ASCII.GetBytes('data'))
  $writer.Write([int]$combined.Length)
  $writer.Write($combined)
} finally {
  $writer.Dispose()
}

$derivedWavSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $wavPath).Hash.ToLowerInvariant()
if ($derivedWavSha256 -ne [string]$definition.expectedDerivedWavSha256) {
  throw 'Generated I3 WAV SHA-256 does not match the tracked deterministic output.'
}
$metadata = [ordered]@{
  schemaVersion = 1
  id = [string]$definition.id
  file = [System.IO.Path]::GetFileName($wavPath)
  sourceCorpusSha256 = $sourceSha256
  sourceReferenceSha256 = [string]$definition.sourceCorpus.referenceSha256
  referenceSha256 = [string]$definition.referenceSha256
  sliceStartMs = [int]$definition.sliceStartMs
  sliceLengthMs = [int]$definition.sliceLengthMs
  sliceLeadingSilenceMs = [int]$definition.sliceLeadingSilenceMs
  sliceSampleCount = $sliceSampleCount
  derivedWavSha256 = $derivedWavSha256
  silenceDurationMs = [int]$definition.silenceDurationMs
  cycleDurationMs = $cycleDurationMs
}
$metadataJson = $metadata | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($metadataPath, $metadataJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$metadataJson
