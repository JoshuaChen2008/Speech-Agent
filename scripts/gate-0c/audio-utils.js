'use strict'

const crypto = require('node:crypto')

const REQUIRED_VISIBILITY_STAGES = Object.freeze([
  'ready',
  'before-user-gesture-trigger',
  'loopback:first-pcm',
  'mic:first-pcm',
  'mic-probe:first-pcm',
  'after-no-gesture-probe',
  'complete'
])

function encodePcm16Wav (samples, sampleRate = 16000) {
  if (!(samples instanceof Float32Array)) throw new TypeError('samples must be a Float32Array')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new TypeError('sampleRate must be a positive integer')
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    buffer.writeInt16LE(value, 44 + (index * 2))
  }
  return buffer
}

function parsePcm16Wav (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('WAV is too short')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid RIFF/WAVE header')

  let format = null
  let data = null
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) throw new Error(`Truncated ${id} chunk`)
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid fmt chunk')
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      }
    } else if (id === 'data') {
      data = buffer.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (!format || !data) throw new Error('WAV requires fmt and data chunks')
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) throw new Error('Expected mono PCM16 WAV')
  if (data.length % 2 !== 0) throw new Error('PCM16 data size must be even')

  const samples = new Float32Array(data.length / 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = data.readInt16LE(index * 2) / 32768
  return { ...format, dataBytes: data.length, sampleCount: samples.length, samples }
}

function rms (samples, start = 0, end = samples.length) {
  if (end <= start) return 0
  let sum = 0
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index]
  return Math.sqrt(sum / (end - start))
}

function dbfs (value) {
  return value > 0 ? 20 * Math.log10(value) : -240
}

function toneAmplitude (samples, sampleRate, frequency, start, length) {
  if (length < 2) return 0
  let real = 0
  let imaginary = 0
  let windowSum = 0
  for (let offset = 0; offset < length; offset += 1) {
    const window = 0.5 - (0.5 * Math.cos((2 * Math.PI * offset) / (length - 1)))
    const phase = (2 * Math.PI * frequency * offset) / sampleRate
    const value = samples[start + offset] * window
    real += value * Math.cos(phase)
    imaginary -= value * Math.sin(phase)
    windowSum += window
  }
  return (2 * Math.sqrt((real * real) + (imaginary * imaginary))) / windowSum
}

function strongestWindow (samples, sampleRate) {
  const length = Math.min(samples.length, Math.round(sampleRate * 0.8))
  const step = Math.max(1, Math.round(sampleRate * 0.05))
  let bestStart = 0
  let bestRms = -1
  for (let start = 0; start + length <= samples.length; start += step) {
    const value = rms(samples, start, start + length)
    if (value > bestRms) { bestRms = value; bestStart = start }
  }
  return { start: bestStart, length, rms: Math.max(0, bestRms) }
}

function analyzeSamples (samples, sampleRate, expectedFrequencyHz = 997, frameSamples = 1600, probeWindow = null) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new TypeError('non-empty Float32Array required')
  let peak = 0
  let sum = 0
  let dc = 0
  let clippingCount = 0
  let preClampOverRangeCount = 0
  let nonFiniteCount = 0
  let maxAdjacentDelta = 0
  let maxFrameBoundaryDelta = 0
  let longestFullScaleRun = 0
  let fullScaleRun = 0
  let nonSilentCount = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    if (!Number.isFinite(value)) { nonFiniteCount += 1; continue }
    const absolute = Math.abs(value)
    peak = Math.max(peak, absolute)
    sum += value * value
    dc += value
    if (absolute > 1) preClampOverRangeCount += 1
    if (absolute >= 0.999) { clippingCount += 1; fullScaleRun += 1; longestFullScaleRun = Math.max(longestFullScaleRun, fullScaleRun) } else fullScaleRun = 0
    if (absolute >= 0.0005) nonSilentCount += 1
    if (index > 0) {
      const delta = Math.abs(value - samples[index - 1])
      maxAdjacentDelta = Math.max(maxAdjacentDelta, delta)
      if (index % frameSamples === 0) maxFrameBoundaryDelta = Math.max(maxFrameBoundaryDelta, delta)
    }
  }

  const overallRms = Math.sqrt(sum / samples.length)
  const dcOffset = dc / samples.length
  const acRms = Math.sqrt(Math.max(0, (overallRms * overallRms) - (dcOffset * dcOffset)))
  let window
  let windowMode = 'strongest'
  if (probeWindow && Number.isFinite(probeWindow.startSeconds) && Number.isFinite(probeWindow.durationSeconds)) {
    const paddingSeconds = 0.1
    const start = Math.max(0, Math.round((probeWindow.startSeconds - paddingSeconds) * sampleRate))
    const length = Math.min(samples.length - start, Math.round((probeWindow.durationSeconds + (paddingSeconds * 2)) * sampleRate))
    window = { start, length, rms: rms(samples, start, start + length) }
    windowMode = 'scheduled'
  } else {
    window = strongestWindow(samples, sampleRate)
  }
  let dominantFrequencyHz = null
  let dominantAmplitude = 0
  for (let frequency = expectedFrequencyHz - 50; frequency <= expectedFrequencyHz + 50; frequency += 1) {
    const amplitude = toneAmplitude(samples, sampleRate, frequency, window.start, window.length)
    if (amplitude > dominantAmplitude) { dominantAmplitude = amplitude; dominantFrequencyHz = frequency }
  }
  const toneRms = dominantAmplitude / Math.sqrt(2)
  const residualRms = Math.sqrt(Math.max(1e-12, (window.rms * window.rms) - (toneRms * toneRms)))
  const snrDb = 20 * Math.log10(Math.max(toneRms, 1e-12) / residualRms)

  const round = (value) => Number(value.toFixed(6))
  return {
    sampleCount: samples.length,
    durationSeconds: round(samples.length / sampleRate),
    peak: round(peak),
    rms: round(overallRms),
    rmsDbfs: round(dbfs(overallRms)),
    dcOffset: round(dcOffset),
    acRms: round(acRms),
    acRmsDbfs: round(dbfs(acRms)),
    nonSilentRatio: round(nonSilentCount / samples.length),
    clippingCount,
    clippedRatio: round(clippingCount / samples.length),
    preClampOverRangeCount,
    longestFullScaleRun,
    nonFiniteCount,
    maxAdjacentDelta: round(maxAdjacentDelta),
    maxFrameBoundaryDelta: round(maxFrameBoundaryDelta),
    probe: {
      expectedFrequencyHz,
      observedFrequencyHz: dominantFrequencyHz,
      frequencyErrorHz: dominantFrequencyHz == null ? null : Math.abs(dominantFrequencyHz - expectedFrequencyHz),
      amplitude: round(dominantAmplitude),
      snrDb: round(snrDb),
      windowMode,
      analysisWindowStartSeconds: round(window.start / sampleRate),
      analysisWindowDurationSeconds: round(window.length / sampleRate)
    }
  }
}

function sha256 (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function formatPasses (format) {
  return format.audioFormat === 1 && format.channels === 1 && format.sampleRate === 16000 && format.bitsPerSample === 16 && format.blockAlign === 2 && format.byteRate === 32000 && format.dataBytes === format.sampleCount * 2
}

function evaluateCaptureChecks (sourceId, analysis, pipeline, inputPreClampOverRangeCount) {
  if (!['loopback', 'mic', 'mic-probe'].includes(sourceId)) throw new TypeError('sourceId must be loopback, mic, or mic-probe')
  const clockCoverageRatio = analysis.durationSeconds / pipeline.wallElapsedSeconds
  const expectedFrameCount = pipeline.fullFrameCount + (pipeline.tailFrameSamples < pipeline.frameSamples ? 1 : 0)
  const pipelinePass = pipeline.outputSampleRate === 16000 &&
    pipeline.frameSamples === 1600 &&
    pipeline.sequenceGapCount === 0 &&
    pipeline.timestampRegressionCount === 0 &&
    pipeline.fullFrameCount >= 1 &&
    pipeline.tailFrameSamples > 0 &&
    pipeline.tailFrameSamples <= pipeline.frameSamples &&
    pipeline.frameCount === expectedFrameCount &&
    pipeline.sampleCount === analysis.sampleCount &&
    clockCoverageRatio >= 0.9 &&
    clockCoverageRatio <= 1.1
  const noClipping = inputPreClampOverRangeCount === 0 && analysis.nonFiniteCount === 0 && analysis.clippedRatio < 0.001 && analysis.longestFullScaleRun < 3
  const noLargeDiscontinuity = analysis.maxAdjacentDelta < 0.95 && analysis.maxFrameBoundaryDelta < 0.95
  const signalPresent = analysis.acRmsDbfs > -65 && analysis.nonSilentRatio > 0.01
  const probeDetected = sourceId === 'mic'
    ? analysis.probe.frequencyErrorHz <= 10 && analysis.probe.amplitude >= 0.003 && analysis.probe.snrDb >= -30
    : analysis.probe.frequencyErrorHz <= 10 && analysis.probe.amplitude >= 0.01 && analysis.probe.snrDb >= -20
  const probeRequired = sourceId !== 'mic'
  return {
    clockCoverageRatio: Number(clockCoverageRatio.toFixed(6)),
    pipelinePass,
    noClipping,
    noLargeDiscontinuity,
    signalPresent,
    probeDetected,
    probeRequired,
    pass: pipelinePass && noClipping && noLargeDiscontinuity && signalPresent && (!probeRequired || probeDetected)
  }
}

function evaluateGate0CDecision ({ capture, diagnostics, artifacts, displayRequests, visibility }) {
  const evidence = diagnostics || artifacts
  if (!capture || !evidence || !Array.isArray(displayRequests) || !Array.isArray(visibility)) throw new TypeError('complete Gate 0C evidence is required')

  const loopbackPass = capture.loopback?.status === 'ok' &&
    capture.loopback?.capture?.playback?.output?.selected === 'default' &&
    evidence.loopback?.checks?.pass === true
  const physicalMicrophonePass = capture.mic?.status === 'ok' &&
    capture.mic?.selection === 'physical-preferred' &&
    evidence.mic?.checks?.pass === true
  const deterministicMicrophoneProbePass = capture.micProbe?.status === 'ok' &&
    capture.micProbe?.selection === 'virtual-cable' &&
    capture.micProbe?.capture?.playback?.output?.selected === 'virtual-cable' &&
    evidence['mic-probe']?.checks?.pass === true
  const microphonePass = physicalMicrophonePass && deterministicMicrophoneProbePass

  const requiredVisibilityStagesPresent = REQUIRED_VISIBILITY_STAGES.every((stage) => visibility.some((event) => event?.stage === stage))
  const hiddenThroughout = requiredVisibilityStagesPresent && visibility.every((event) => event?.visible === false)
  const actualDisplayRequest = [...displayRequests].reverse().find((request) => request?.userGesture === true) || null
  const displayRequestPass = actualDisplayRequest?.securityOrigin === 'file://' &&
    actualDisplayRequest?.videoRequested === true &&
    actualDisplayRequest?.audioRequested === true &&
    actualDisplayRequest?.frameMatchedHost === true &&
    actualDisplayRequest?.hostVisible === false &&
    actualDisplayRequest?.callbackAudio === 'loopback' &&
    actualDisplayRequest?.callbackVideoSourceType === 'screen' &&
    actualDisplayRequest?.error == null
  const hiddenSchemePass = hiddenThroughout && displayRequestPass && loopbackPass

  const diagnosticsComplete = ['loopback', 'mic', 'mic-probe'].every((sourceId) =>
    evidence[sourceId]?.pipeline && evidence[sourceId]?.analysis && evidence[sourceId]?.checks)
  const hashes = artifacts
    ? ['loopback', 'mic', 'mic-probe'].map((sourceId) => artifacts[sourceId]?.artifact?.sha256)
    : []
  const artifactHashesIndependent = artifacts
    ? hashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) && new Set(hashes).size === hashes.length
    : null
  const evidencePass = artifacts ? artifactHashesIndependent : diagnosticsComplete
  const result = hiddenSchemePass && microphonePass && evidencePass
    ? 'pass'
    : (hiddenSchemePass && !microphonePass ? 'inconclusive-microphone-signal' : 'fail')

  const decision = {
    result,
    hiddenThroughout,
    requiredVisibilityStagesPresent,
    displayRequestPass,
    hiddenSchemePass,
    loopbackPass,
    physicalMicrophonePass,
    deterministicMicrophoneProbePass,
    microphonePass
  }
  if (artifacts) decision.artifactHashesIndependent = artifactHashesIndependent
  else decision.diagnosticsComplete = diagnosticsComplete
  return decision
}

module.exports = {
  REQUIRED_VISIBILITY_STAGES,
  analyzeSamples,
  encodePcm16Wav,
  evaluateCaptureChecks,
  evaluateGate0CDecision,
  formatPasses,
  parsePcm16Wav,
  sha256
}
