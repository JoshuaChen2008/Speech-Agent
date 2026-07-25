param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\models\gate-0b\corpus')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Speech

$definitionPath = Join-Path $PSScriptRoot 'corpus.json'
$definition = Get-Content -Raw -Encoding UTF8 -LiteralPath $definitionPath | ConvertFrom-Json
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
  [int]$definition.sampleRate,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$availableVoices = @{}
$probe = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  foreach ($voice in $probe.GetInstalledVoices()) {
    $availableVoices[$voice.VoiceInfo.Name] = $true
  }
} finally {
  $probe.Dispose()
}

$metadata = @()
foreach ($case in $definition.cases) {
  $wavPath = Join-Path $outputPath ($case.id + '.wav')
  $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    if ($case.PSObject.Properties.Name -contains 'voice') {
      if (-not $availableVoices.ContainsKey([string]$case.voice)) {
        throw "Required SAPI voice is not installed: $($case.voice)"
      }
      $synth.SelectVoice([string]$case.voice)
    }
    $synth.SetOutputToWaveFile($wavPath, $format)
    if ($case.PSObject.Properties.Name -contains 'ssml') {
      $synth.SpeakSsml([string]$case.ssml)
    } else {
      $synth.Speak([string]$case.text)
    }
  } finally {
    $synth.Dispose()
  }

  $file = Get-Item -LiteralPath $wavPath
  $metadata += [ordered]@{
    id = [string]$case.id
    category = [string]$case.category
    file = $file.Name
    bytes = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $wavPath).Hash.ToLowerInvariant()
    reference = [string]$case.reference
  }
}

$result = [ordered]@{
  schemaVersion = 1
  generatedAt = [DateTime]::UtcNow.ToString('o')
  format = [ordered]@{
    sampleRate = [int]$definition.sampleRate
    bitsPerSample = [int]$definition.bitsPerSample
    channels = [int]$definition.channels
  }
  cases = $metadata
}

$metadataPath = Join-Path $outputPath 'metadata.json'
$result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $metadataPath
$result | ConvertTo-Json -Depth 8
