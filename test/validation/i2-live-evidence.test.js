'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const REPORT_PATH = path.resolve(__dirname, '../../docs/validation/i2-loopback-results.json')
const RUNNER_PATH = path.resolve(__dirname, '../../scripts/i2-live-caption-smoke.js')
const { buildMicPromptNotice, buildReport, parseArguments } = require('../../scripts/i2-live-caption-smoke')

test('published I2 loopback evidence proves one lossless real-model run without overclaiming mic', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.kind, 'i2-live-caption-smoke')
  assert.equal(report.executedAt, '2026-07-31T02:51:41.094Z')
  assert.equal(report.sourceId, 'loopback')
  assert.equal(report.result, 'pass')
  assert.equal(report.counts.finals, 1)
  assert.equal(report.counts.refined, 1)
  assert.equal(report.accuracy.finalCer, 0)
  assert.equal(report.accuracy.refinedCer, 0)
  assert.equal(report.accuracy.refinedHasPunctuation, true)
  assert.equal(report.transport.capturedFrames, 128)
  assert.equal(report.transport.sentFrames, 128)
  assert.equal(report.transport.ingestedFrames, 128)
  for (const key of [
    'droppedFrames',
    'sequenceGapCount',
    'missedFrames',
    'badSampleTypeFrames',
    'lostInFlightFrames',
    'discardedAtStop',
    'droppedCaptionCount'
  ]) assert.equal(report.transport[key], 0, `${key} must remain zero in the published run`)
  assert.equal(report.transport.creditStalls, 0)
  assert.equal(report.transport.maxQueuedMsObserved, 0)
  assert.equal(report.transport.portReplacements, 0)
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    reportContainsTranscriptText: false,
    reportContainsAudioPath: false
  })
  assert.ok(report.limitations.some((item) => /microphone.*pending/i.test(item)))

  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/, 'tracked evidence must not expose local paths')
  assert.doesNotMatch(serialized, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i)
  assert.doesNotMatch(serialized, /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i)
})

test('I2 live runner requires exactly one explicit source', () => {
  assert.throws(() => parseArguments([]), /--source is required/)
  assert.equal(parseArguments(['--source', 'loopback']).source, 'loopback')
  assert.equal(parseArguments(['--source', 'mic', '--listen-seconds', '15']).source, 'mic')
  assert.throws(() => parseArguments(['--source', 'loopback,mic']), /--source is required/)
  assert.throws(() => parseArguments(['--source', 'loopback', '--source', 'mic']), /exactly once/)
  assert.deepEqual(buildMicPromptNotice(15), {
    status: 'awaiting-microphone-speech',
    seconds: 15,
    promptId: 'zh-en-code-switch'
  }, 'mic notice identifies the frozen corpus without logging its text')

  const source = fs.readFileSync(RUNNER_PATH, 'utf8')
  const writeTargets = [...source.matchAll(/fs\.writeFileSync\(([^,\n]+)/g)].map((match) => match[1].trim())
  assert.deepEqual([...new Set(writeTargets)], ['reportPath'], 'runner may persist only its JSON report')
})

test('runner report builder emits the same text-free schema as tracked evidence', () => {
  const report = buildReport({
    executedAt: '2026-07-31T00:00:00.000Z',
    environment: { electron: 'test', node: 'test' },
    sourceId: 'mic',
    result: 'pass',
    model: { id: 'model', profile: 'fast', numThreads: 1 },
    vad: 'silero',
    refinement: null,
    stimulus: { kind: 'operator-spoken-prompt', corpusId: 'frozen-case', listenSeconds: 12 },
    failures: [],
    phases: ['listening', 'idle'],
    counts: { captions: 2, partials: 1, finals: 1, refined: 0 },
    accuracy: { finalCer: 0, refinedCer: null, refinedHasPunctuation: null },
    timings: { firstPartialFromStimulusStartMs: 100, captionArrivalCount: 2 },
    resources: { sampleCount: 2 },
    peakRms: 0.2,
    diagnostics: {
      capture: { mic: { capturedFrames: 2, sentFrames: 2, droppedFrames: 0, maxQueuedMsObserved: 0 } },
      worker: { badSampleTypeFrames: 0, sources: { mic: { framesIngested: 2, sequenceGapCount: 0, missedFrames: 0 } } },
      droppedCaptionCount: 0
    }
  })
  assert.deepEqual(Object.keys(report), Object.keys(JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))))
  assert.equal(report.privacy.reportContainsTranscriptText, false)
  assert.doesNotMatch(JSON.stringify(report), /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i)
})
