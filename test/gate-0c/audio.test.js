'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  analyzeSamples,
  encodePcm16Wav,
  evaluateCaptureChecks,
  evaluateGate0CDecision,
  formatPasses,
  parsePcm16Wav
} = require('../../scripts/gate-0c/audio-utils')

function sine (sampleRate, seconds, frequency, amplitude = 0.2) {
  const samples = new Float32Array(Math.round(sampleRate * seconds))
  const fadeSamples = Math.round(sampleRate * 0.04)
  for (let index = 0; index < samples.length; index += 1) {
    const edge = Math.min(1, index / fadeSamples, (samples.length - 1 - index) / fadeSamples)
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude * Math.max(0, edge)
  }
  return samples
}

test('streaming resampler preserves phase across arbitrary block boundaries', async () => {
  const { StreamingLinearResampler } = await import('../../scripts/gate-0c/streaming-resampler.mjs')
  const input = sine(48000, 1, 997)
  const whole = new StreamingLinearResampler(48000, 16000)
  const expected = [...whole.push(input), ...whole.flush()]
  const split = new StreamingLinearResampler(48000, 16000)
  const chunks = []
  const sizes = [113, 257, 64, 511, 128]
  for (let offset = 0, index = 0; offset < input.length; index += 1) {
    const end = Math.min(input.length, offset + sizes[index % sizes.length])
    chunks.push(...split.push(input.slice(offset, end)))
    offset = end
  }
  chunks.push(...split.flush())
  assert.equal(chunks.length, 16000)
  assert.deepEqual(chunks, expected)
})

test('downmix averages equal-length channels to mono', async () => {
  const { downmixToMono } = await import('../../scripts/gate-0c/streaming-resampler.mjs')
  assert.deepEqual([...downmixToMono([Float32Array.from([1, -1]), Float32Array.from([-1, 1])])], [0, 0])
  assert.throws(() => downmixToMono([new Float32Array(1), new Float32Array(2)]), /equal-length/)
})

test('WAV encoder round-trips mono 16 kHz PCM16 with a valid RIFF layout', () => {
  const wav = encodePcm16Wav(sine(16000, 1, 997), 16000)
  const parsed = parsePcm16Wav(wav)
  assert.equal(wav.length, 32044)
  assert.equal(parsed.sampleCount, 16000)
  assert.equal(formatPasses(parsed), true)
})

test('signal analysis detects the independent 997 Hz probe and clipping', () => {
  const clean = analyzeSamples(sine(16000, 1, 997), 16000, 997)
  assert.ok(clean.probe.frequencyErrorHz <= 1)
  assert.ok(clean.probe.amplitude > 0.1)
  assert.equal(clean.clippingCount, 0)

  const clipped = new Float32Array(16000).fill(1)
  assert.ok(analyzeSamples(clipped, 16000, 997).clippingCount > 0)
})

test('capture decision rejects silent or discontinuous pipelines', () => {
  const analysis = analyzeSamples(sine(16000, 1, 997), 16000, 997)
  const pipeline = {
    outputSampleRate: 16000,
    frameSamples: 1600,
    fullFrameCount: 10,
    tailFrameSamples: 1600,
    frameCount: 10,
    sampleCount: 16000,
    sequenceGapCount: 0,
    timestampRegressionCount: 0,
    wallElapsedSeconds: 1
  }
  assert.equal(evaluateCaptureChecks('loopback', analysis, pipeline, 0).pass, true)
  assert.equal(evaluateCaptureChecks('loopback', { ...analysis, acRmsDbfs: -240 }, pipeline, 0).pass, false)
  assert.equal(evaluateCaptureChecks('loopback', analysis, { ...pipeline, sequenceGapCount: 1 }, 0).pass, false)

  const stuckDc = analyzeSamples(new Float32Array(16000).fill(0.01), 16000, 997)
  assert.equal(stuckDc.acRmsDbfs, -240)
  assert.equal(evaluateCaptureChecks('mic', stuckDc, pipeline, 0).pass, false)
})

test('Gate decision supports metrics-only runs and fails closed on legacy reused artifacts', () => {
  const requiredVisibility = [
    'ready',
    'before-user-gesture-trigger',
    'loopback:first-pcm',
    'mic:first-pcm',
    'mic-probe:first-pcm',
    'after-no-gesture-probe',
    'complete'
  ].map((stage) => ({ stage, visible: false }))
  const capture = {
    loopback: { status: 'ok', capture: { playback: { output: { selected: 'default' } } } },
    mic: { status: 'ok', selection: 'physical-preferred' },
    micProbe: { status: 'ok', selection: 'virtual-cable', capture: { playback: { output: { selected: 'virtual-cable' } } } }
  }
  const artifacts = {
    loopback: { artifact: { sha256: '1'.repeat(64) }, checks: { pass: true } },
    mic: { artifact: { sha256: '2'.repeat(64) }, checks: { pass: true } },
    'mic-probe': { artifact: { sha256: '3'.repeat(64) }, checks: { pass: true } }
  }
  const displayRequests = [{
    securityOrigin: 'file://',
    videoRequested: true,
    audioRequested: true,
    userGesture: true,
    frameMatchedHost: true,
    hostVisible: false,
    callbackAudio: 'loopback',
    callbackVideoSourceType: 'screen',
    error: null
  }]
  const evidence = { capture, artifacts, displayRequests, visibility: requiredVisibility }
  assert.equal(evaluateGate0CDecision(evidence).result, 'pass')
  assert.equal(evaluateGate0CDecision({ ...evidence, capture: { ...capture, mic: { ...capture.mic, selection: 'default-fallback' } } }).physicalMicrophonePass, false)
  assert.equal(evaluateGate0CDecision({ ...evidence, capture: { ...capture, micProbe: { ...capture.micProbe, capture: { playback: { output: { selected: 'default' } } } } } }).deterministicMicrophoneProbePass, false)
  assert.equal(evaluateGate0CDecision({ ...evidence, visibility: requiredVisibility.slice(1) }).hiddenThroughout, false)
  assert.equal(evaluateGate0CDecision({ ...evidence, displayRequests: [{ ...displayRequests[0], hostVisible: true }] }).displayRequestPass, false)
  assert.equal(evaluateGate0CDecision({ ...evidence, artifacts: { ...artifacts, 'mic-probe': { ...artifacts['mic-probe'], artifact: { sha256: '1'.repeat(64) } } } }).artifactHashesIndependent, false)

  const diagnostics = Object.fromEntries(['loopback', 'mic', 'mic-probe'].map((sourceId) => [
    sourceId,
    { pipeline: { sampleCount: 1 }, analysis: { acRmsDbfs: -10 }, checks: { pass: true } }
  ]))
  const metricsOnly = evaluateGate0CDecision({ capture, diagnostics, displayRequests, visibility: requiredVisibility })
  assert.equal(metricsOnly.result, 'pass')
  assert.equal(metricsOnly.diagnosticsComplete, true)
  assert.equal(Object.hasOwn(metricsOnly, 'artifactHashesIndependent'), false)
})

test('current Gate 0C runner analyzes samples in memory and contains no audio write path', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../scripts/gate-0c/main.js'), 'utf8')
  const preload = fs.readFileSync(path.resolve(__dirname, '../../scripts/gate-0c/preload.js'), 'utf8')
  assert.match(main, /gate-0c:analyze-capture/)
  assert.match(preload, /analyzeCapture/)
  assert.doesNotMatch(main, /encodePcm16Wav|parsePcm16Wav|\.wav|save-capture/)
})

test('published Gate 0C evidence records three independent passing routes without local paths', () => {
  const reportPath = path.resolve(__dirname, '../../docs/validation/gate-0c-results.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.result, 'pass')
  assert.equal(report.decision.hiddenSchemePass, true)
  assert.equal(report.decision.requiredVisibilityStagesPresent, true)
  assert.equal(report.decision.displayRequestPass, true)
  assert.equal(report.decision.artifactHashesIndependent, true)
  assert.equal(report.decision.selectedTopology, 'hidden-audio-host')
  assert.equal(report.capture.mic.selection, 'physical-preferred')
  assert.equal(report.capture.micProbe.selection, 'virtual-cable')
  assert.equal(report.capture.micProbe.capture.playback.output.selected, 'virtual-cable')
  assert.ok(report.displayRequests.some((request) => request.userGesture === true && request.frameMatchedHost === true && request.callbackAudio === 'loopback'))
  assert.ok(report.window.visibility.every((event) => event.visible === false))
  for (const sourceId of ['loopback', 'mic', 'mic-probe']) {
    assert.equal(report.artifacts[sourceId].checks.pass, true)
    assert.equal(report.artifacts[sourceId].checks.formatPass, true)
    assert.equal(report.artifacts[sourceId].format.sampleRate, 16000)
    assert.equal(report.artifacts[sourceId].format.channels, 1)
    assert.equal(report.artifacts[sourceId].format.bitsPerSample, 16)
    assert.ok(report.artifacts[sourceId].analysis.acRmsDbfs > -65)
    assert.match(report.artifacts[sourceId].artifact.sha256, /^[a-f0-9]{64}$/)
  }
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts.mic.artifact.sha256)
  assert.notEqual(report.artifacts.mic.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
})
