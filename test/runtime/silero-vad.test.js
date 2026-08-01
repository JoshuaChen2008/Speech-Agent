'use strict'

/* silero VAD 测试：
   - 纯逻辑（注入 nativeVad 替身）：转移映射、强制收束、reset——CI 可跑。
   - 集成（本机模型 + 原生绑定，缺则 skip）：语料分段、纯音拒识、与真实
     recognizer 合流后切字回归（EnergyVad 曾把「一下」切成「一」）。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PRE_ROLL_RMS, SileroVad, assertSileroVadOptions } = require('../../src/runtime/realtime-worker/silero-vad')

const VAD_MODEL = path.resolve(__dirname, '../../models/vad/silero_vad.onnx')
const ASR_MODEL_DIR = path.resolve(
  __dirname,
  '../../models/gate-0b/extracted/x-asr-160/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
)
const WAV_PATH = path.resolve(__dirname, '../../models/gate-0b/corpus/zh-en-code-switch.wav')

function sherpaLoadable () {
  try {
    require.resolve('sherpa-onnx-node')
    return true
  } catch {
    return false
  }
}

const vadAssetPresent = fs.existsSync(VAD_MODEL) && sherpaLoadable()
const fullAssetsPresent = vadAssetPresent && fs.existsSync(WAV_PATH) &&
  ['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx']
    .every((name) => fs.existsSync(path.join(ASR_MODEL_DIR, name)))
const skipVad = !vadAssetPresent && 'local silero model or sherpa binding missing'
const skipFull = !fullAssetsPresent && 'local Gate 0B assets, silero model or sherpa binding missing'

const FRAME = 1600

function speechFrame (level = 0.1) {
  const samples = new Float32Array(FRAME)
  for (let index = 0; index < samples.length; index += 1) samples[index] = level
  return samples
}

/* -------- 纯逻辑（替身 nativeVad）-------- */

function fakeNative (detectedQueue) {
  return {
    accepted: 0,
    resets: 0,
    detected: false,
    acceptWaveform () {
      this.accepted += 1
      if (detectedQueue.length > 0) this.detected = detectedQueue.shift()
    },
    isEmpty () { return true },
    pop () {},
    isDetected () { return this.detected },
    reset () { this.resets += 1 }
  }
}

const BASE_OPTIONS = { kind: 'silero', modelPath: 'unused-with-fake' }

test('silero wrapper maps isDetected transitions to start/end events', () => {
  const vad = new SileroVad(BASE_OPTIONS, fakeNative([false, true, true, false, false]))
  assert.equal(vad.provisionalRecognizerFeed, true)
  assert.equal(vad.push(speechFrame()).event, null)
  const start = vad.push(speechFrame())
  assert.equal(start.event, 'speech-start')
  assert.equal(start.voiced, true, `speech-level frame must pass the ${PRE_ROLL_RMS} pre-roll heuristic`)
  assert.equal(vad.push(speechFrame()).event, null)
  const end = vad.push(new Float32Array(FRAME))
  assert.equal(end.event, 'speech-end')
  assert.equal(end.forced, false)
  assert.equal(end.voiced, false, 'digital silence must not enter the pre-roll buffer')
  assert.equal(vad.push(new Float32Array(FRAME)).event, null)
})

test('silero wrapper forces segment end at the frame cap and re-opens immediately', () => {
  const vad = new SileroVad({ ...BASE_OPTIONS, maxSegmentFrames: 3 }, fakeNative([true, true, true, true, true]))
  assert.equal(vad.push(speechFrame()).event, 'speech-start')
  assert.equal(vad.push(speechFrame()).event, null)
  const forced = vad.push(speechFrame())
  assert.equal(forced.event, 'speech-end')
  assert.equal(forced.forced, true)
  assert.equal(vad.push(speechFrame()).event, 'speech-start', 'continuous speech re-opens right after a forced end')
})

test('silero wrapper reset clears state and resets the native detector', () => {
  const native = fakeNative([true])
  const vad = new SileroVad(BASE_OPTIONS, native)
  assert.equal(vad.push(speechFrame()).event, 'speech-start')
  vad.reset()
  assert.equal(native.resets, 1)
  assert.equal(vad.inSpeech, false)
})

test('silero option validation rejects malformed configurations', () => {
  assert.throws(() => assertSileroVadOptions(null), /required/)
  assert.throws(() => assertSileroVadOptions({ kind: 'energy', modelPath: 'x' }), /unsupported/)
  assert.throws(() => assertSileroVadOptions({ kind: 'silero', modelPath: '' }), /modelPath/)
  assert.throws(() => assertSileroVadOptions({ kind: 'silero', modelPath: 'x', threshold: 0 }), /threshold/)
  const normalized = assertSileroVadOptions({ kind: 'silero', modelPath: 'x' })
  assert.equal(normalized.threshold, 0.5)
  assert.equal(normalized.minSpeechDuration, 0.25)
  assert.equal(normalized.minSilenceDuration, 1.0, 'the measured sentence-level default (see silero-vad.js rationale)')
  assert.ok(Object.isFrozen(normalized))
})

/* -------- 集成（真实 silero 模型）-------- */

test('real silero detects corpus speech segments and rejects a pure tone', { skip: skipVad }, () => {
  const sherpa = require('sherpa-onnx-node')
  const vad = new SileroVad({ kind: 'silero', modelPath: VAD_MODEL })
  const wave = sherpa.readWave(WAV_PATH)

  let segments = 0
  let ended = 0
  for (let offset = 0; offset < wave.samples.length; offset += FRAME) {
    const verdict = vad.push(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + FRAME)))
    if (verdict.event === 'speech-start') segments += 1
    if (verdict.event === 'speech-end') ended += 1
  }
  for (let index = 0; index < 20 && ended < segments; index += 1) {
    if (vad.push(new Float32Array(FRAME)).event === 'speech-end') ended += 1
  }
  /* 默认 1.0s 收句静音会把语料的词间停顿（0.7-0.9s）桥接为整句；上限
     防退化成逐词碎段。 */
  assert.ok(segments >= 1 && segments <= 4, `expected sentence-level segmentation, got ${segments}`)
  assert.equal(ended, segments, 'every segment must close after trailing silence')

  vad.reset()
  const tone = new Float32Array(FRAME)
  let toneSpeech = false
  for (let frame = 0; frame < 30; frame += 1) {
    for (let index = 0; index < tone.length; index += 1) {
      tone[index] = 0.5 * Math.sin(2 * Math.PI * 997 * ((frame * FRAME) + index) / 16000)
    }
    if (vad.push(tone).event === 'speech-start') toneSpeech = true
  }
  assert.equal(toneSpeech, false, 'a 997Hz pure tone must not be detected as speech (the energy placeholder fails this)')
})

test('product candidate prefeed reaches real Silero confirmation before its bounded cap', { skip: skipVad }, () => {
  const sherpa = require('sherpa-onnx-node')
  const { WorkerCore, SAMPLE_RATE } = require('../../src/runtime/realtime-worker/worker-core')
  const core = new WorkerCore({
    sessionId: 'silero-product-candidate-diagnostic',
    sourceIds: ['loopback'],
    vadFactory: () => new SileroVad({ kind: 'silero', modelPath: VAD_MODEL }),
    preRollLimit: 6
  })
  const wave = sherpa.readWave(WAV_PATH)
  let sequence = 0
  let samplesFed = 0
  const feed = (samples) => {
    core.ingestFrame({
      sourceId: 'loopback',
      sequence: sequence++,
      timestampSeconds: samplesFed / SAMPLE_RATE,
      sampleCount: samples.length,
      samples
    })
    samplesFed += samples.length
  }

  for (let offset = 0; offset < wave.samples.length; offset += 1600) {
    feed(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + 1600)))
  }
  for (let index = 0; index < 16; index += 1) feed(new Float32Array(1600))

  const metrics = core.metrics().loopback
  assert.equal(metrics.segmentsDetected, 1)
  assert.equal(metrics.provisionalCandidatesStarted, 1)
  assert.equal(metrics.provisionalDiscards, 0)
  assert.equal(metrics.provisionalSuppressions, 0)
  assert.equal(metrics.provisionalConfirmed, 1)
  assert.ok(metrics.provisionalLastCandidateFramesFed >= 2)
  assert.ok(metrics.provisionalLastCandidateAudioMs >= 200)
  core.dispose()
})

test('silero plus the real recognizer keeps words the energy placeholder used to cut', { skip: skipFull }, () => {
  const sherpa = require('sherpa-onnx-node')
  const { WorkerCore, SAMPLE_RATE } = require('../../src/runtime/realtime-worker/worker-core')
  const { registerRecognizerAdapter } = require('../../src/runtime/realtime-worker/recognizer-adapter')
  const { SherpaOnlineRecognizerAdapter } = require('../../src/runtime/realtime-worker/sherpa-recognizer')
  const { characterErrorRate } = require('../../scripts/gate-0b/metrics')
  const corpus = require('../../scripts/gate-0b/corpus.json')
  const reference = corpus.cases.find((item) => item.id === 'zh-en-code-switch').reference

  registerRecognizerAdapter('test-silero-x160', () => new SherpaOnlineRecognizerAdapter({
    kind: 'sherpa-online-transducer',
    modelDir: ASR_MODEL_DIR,
    numThreads: 4
  }))
  const core = new WorkerCore({
    sessionId: 'session-silero-integration',
    sourceIds: ['loopback'],
    recognizerProfile: 'test-silero-x160',
    vadFactory: () => new SileroVad({ kind: 'silero', modelPath: VAD_MODEL }),
    preRollLimit: 6
  })

  const wave = sherpa.readWave(WAV_PATH)
  assert.equal(wave.sampleRate, SAMPLE_RATE)
  const events = []
  let sequence = 0
  let clock = 0
  const feed = (samples) => {
    events.push(...core.ingestFrame({
      sourceId: 'loopback', sequence: sequence++, timestampSeconds: clock, sampleCount: samples.length, samples
    }))
    clock += samples.length / SAMPLE_RATE
  }
  for (let offset = 0; offset < wave.samples.length; offset += FRAME) {
    feed(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + FRAME)))
  }
  for (let index = 0; index < 15; index += 1) feed(new Float32Array(FRAME))
  events.push(...core.flush(clock))

  const finals = events.filter((event) => event.kind === 'final')
  assert.ok(finals.length >= 1, 'expected finalized segments')
  const joined = finals.map((event) => event.text).join(' ')
  /* 实测回归点：0.5s 收句时流式模型缺右上下文，「一下」被吐成「一」
     （CER 0.036）；1.0s 默认下整句成段、CER 0。门槛 0.03——丢一个字就红。 */
  const cer = characterErrorRate(reference, joined)
  assert.ok(cer < 0.03, `joined final CER ${cer} too high (expected no cut characters): ${joined}`)

  core.dispose()
})
