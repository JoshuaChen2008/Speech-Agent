'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  CreditControlledPcmSender,
  feedWaveInMemory,
  parsePcm16MonoWav
} = require('../../scripts/native-model-activity-support')
const {
  createNativeModelActivityReport,
  readAndValidateNativeModelActivityReport,
  validateNativeModelActivityReport
} = require('../../scripts/verify-native-model-activity-lifecycle-report')

const TRACKED_ACTIVITY_REPORT = path.resolve(
  __dirname,
  '../../docs/validation/native-model-activity-lifecycle-results.json'
)

function iteration (ordinal = 1) {
  return {
    ordinal,
    utility: { distinctProcessPair: true, concurrentDuringActivity: true },
    activity: {
      framesFed: 4,
      framesIngested: 4,
      sequenceGapCount: 0,
      badSampleTypeFrames: 0,
      speechSegmentsDetected: 1,
      finalCaptionCount: 1,
      refinedCaptionCount: 1,
      offlineDecodeCount: 1
    },
    shutdown: {
      realtimeGraceful: true,
      realtimeExitCode: 0,
      refinementGraceful: true,
      refinementExitCode: 0
    }
  }
}

function passingReport (extraState = {}) {
  return createNativeModelActivityReport({
    result: 'pass',
    runtime: { electron: '43.2.0', node: '24.18.0' },
    state: {
      requestedIterations: 1,
      bundleResolved: true,
      realtimeLoaded: true,
      vadLoaded: true,
      refinementLoaded: true,
      fatalErrorCount: 0,
      browserWindowCount: 0,
      audioArtifactCount: 0,
      ...extraState
    },
    iterations: [iteration()]
  })
}

function pcm16Wav (values) {
  const dataBytes = values.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  values.forEach((value, index) => buffer.writeInt16LE(value, 44 + index * 2))
  return buffer
}

class FakePort extends EventEmitter {
  constructor () {
    super()
    this.messages = []
    this.started = false
    this.closed = false
  }

  start () { this.started = true }
  close () { this.closed = true }
  postMessage (message) { this.messages.push(message) }
  grant (count, consumed = 0) { this.emit('message', { data: { type: 'credits', sourceId: 'mic', count, consumed } }) }
}

test('safe report template accepts complete activity and cannot represent private payload fields', () => {
  const report = passingReport({
    transcript: 'must never be copied',
    samples: [0.1],
    modelPath: 'D:\\private\\model',
    audioPath: 'D:\\private\\fixture.wav'
  })
  assert.equal(validateNativeModelActivityReport(report).result, 'pass')
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /must never|private|fixture\.wav|"samples"|"transcript"/i)
})

test('tracked native activity evidence supports every published exact metric without private payloads', () => {
  const report = readAndValidateNativeModelActivityReport(TRACKED_ACTIVITY_REPORT)
  assert.deepEqual(report.metrics, {
    requestedIterations: 3,
    completedIterations: 3,
    concurrentUtilityPairs: 3,
    onlineActivityIterations: 3,
    offlineRefinementIterations: 3,
    totalFramesFed: 303,
    totalFramesIngested: 303,
    totalFinalCaptions: 3,
    totalRefinedCaptions: 3,
    totalOfflineDecodes: 3,
    gracefulRealtimeExits: 3,
    gracefulRefinementExits: 3,
    zeroExitCodeCount: 6,
    fatalErrorCount: 0
  })
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    rawPcmPersisted: false,
    transcriptTextPersisted: false,
    audioPathPersisted: false,
    localPathsPersisted: false,
    diagnosticAudioArtifacts: 0
  })
})

test('report verifier rejects missing activity, nonzero exit and privacy overclaim', () => {
  const report = passingReport()
  assert.throws(() => validateNativeModelActivityReport({
    ...report,
    iterations: [{ ...report.iterations[0], activity: { ...report.iterations[0].activity, offlineDecodeCount: 0 } }]
  }), /activity evidence/)
  assert.throws(() => validateNativeModelActivityReport({
    ...report,
    iterations: [{ ...report.iterations[0], shutdown: { ...report.iterations[0].shutdown, realtimeExitCode: -2147483645 } }]
  }), /exit code zero/)
  assert.throws(() => validateNativeModelActivityReport({
    ...report,
    privacy: { ...report.privacy, rawPcmPersisted: true }
  }), /privacy/)
  assert.throws(() => validateNativeModelActivityReport({ ...report, caption: 'not allowed' }), /unknown fields/)
})

test('smoke has no physical capture or direct-kill path and only writes its JSON report', () => {
  const root = path.join(__dirname, '..', '..')
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'native-model-activity-lifecycle-smoke.js'), 'utf8')
  const support = fs.readFileSync(path.join(root, 'scripts', 'native-model-activity-support.js'), 'utf8')
  assert.doesNotMatch(smoke, /getUserMedia|getDisplayMedia|desktopCapturer|AudioHostController/)
  assert.doesNotMatch(smoke, /\.kill\s*\(/)
  assert.equal((smoke.match(/fsp\.writeFile\s*\(/g) || []).length, 1)
  assert.doesNotMatch(support, /require\(['"]node:fs(?:\/promises)?['"]\)|writeFile|createWriteStream/)
})

test('pure WAV parser and credit sender feed frames only after bounded credits', async () => {
  const wave = parsePcm16MonoWav(pcm16Wav([0, 16384, -16384, 32767]))
  assert.equal(wave.sampleRate, 16000)
  assert.deepEqual([...wave.samples].map((value) => Number(value.toFixed(4))), [0, 0.5, -0.5, 1])

  const port = new FakePort()
  const sender = new CreditControlledPcmSender({
    port,
    sessionId: 'activity-test',
    sourceId: 'mic',
    creditTimeoutMs: 100
  })
  sender.start()
  assert.deepEqual(port.messages.shift(), {
    type: 'ready',
    sessionId: 'activity-test',
    sourceIds: ['mic']
  })

  const feeding = feedWaveInMemory(sender, wave.samples, { frameSamples: 2, trailingSilenceFrames: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(port.messages.length, 0, 'no frame may bypass the product credit protocol')
  port.grant(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(port.messages.length, 1, 'the sender may consume only granted credits')
  port.grant(2, 1)
  const result = await feeding
  assert.equal(result.framesFed, 3)
  assert.equal(port.messages.length, 3)
  assert.ok(port.messages.every((message) => message.type === 'frame' && message.samples instanceof Float32Array))
  sender.end()
  assert.deepEqual(port.messages.at(-1), { type: 'end' })
  sender.close()
  assert.equal(port.closed, true)
})
