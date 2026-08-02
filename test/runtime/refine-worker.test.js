'use strict'

/* B3 精修测试：
   - 纯逻辑：选项校验、worker-core 的段音频上交与 refined 脱段发射
     （sequence/revision 权威不变式）——CI 可跑。
   - 集成（本机离线模型，缺则 skip）：离线识别器对语料出带标点定稿；
     实时(silero+x160) + 精修(离线 X-ASR) 全链纯函数回路。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { assertRefinementOptions } = require('../../src/runtime/refine-worker/offline-recognizer')
const { WorkerCore } = require('../../src/runtime/realtime-worker/worker-core')
const { isCaptionEvent } = require('../../src/contracts')

const REFINE_MODEL_DIR = path.resolve(
  __dirname,
  '../../models/gate-0b/extracted/x-asr-offline/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03'
)
const ASR_MODEL_DIR = path.resolve(
  __dirname,
  '../../models/gate-0b/extracted/x-asr-160/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
)
const VAD_MODEL = path.resolve(__dirname, '../../models/vad/silero_vad.onnx')
const WAV_PATH = path.resolve(__dirname, '../../models/gate-0b/corpus/zh-en-code-switch.wav')

function sherpaLoadable () {
  try {
    require.resolve('sherpa-onnx-node')
    return true
  } catch {
    return false
  }
}

const REFINE_FILES = ['tokens.txt', 'encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx']
const refineAssets = REFINE_FILES.every((name) => fs.existsSync(path.join(REFINE_MODEL_DIR, name))) &&
  fs.existsSync(WAV_PATH) && sherpaLoadable()
const fullChainAssets = refineAssets && fs.existsSync(VAD_MODEL) &&
  ['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx']
    .every((name) => fs.existsSync(path.join(ASR_MODEL_DIR, name)))
const skipRefine = !refineAssets && 'local refinement model assets or sherpa binding missing'
const skipFullChain = !fullChainAssets && 'local model assets or sherpa binding missing'

const FRAME = 1600

test('refinement option validation rejects malformed configurations', () => {
  assert.throws(() => assertRefinementOptions(null), /required/)
  assert.throws(() => assertRefinementOptions({ kind: 'other', modelDir: 'x' }), /unsupported/)
  assert.throws(() => assertRefinementOptions({ kind: 'sherpa-offline-transducer', modelDir: '' }), /modelDir/)
  assert.throws(() => assertRefinementOptions({ kind: 'sherpa-offline-transducer', modelDir: 'x', numThreads: 99 }), /numThreads/)
  const normalized = assertRefinementOptions({ kind: 'sherpa-offline-transducer', modelDir: 'x' })
  assert.equal(normalized.numThreads, 3, 'the M3-evaluated thread count is the default')
  assert.ok(Object.isFrozen(normalized))
})

/* 纯逻辑：脚本化 adapter/vad 驱动 worker-core 的精修回路。 */

function scriptedAdapter (finalText) {
  return { acceptFrame () {}, poll () { return null }, endSegment () { return finalText }, dispose () {} }
}

function scriptedVad (script) {
  return {
    push () {
      const event = script.length > 0 ? script.shift() : null
      return { event, voiced: true, forced: false, rms: 0.1 }
    },
    reset () {}
  }
}

test('worker-core hands finalized segment audio to the refinement requester', () => {
  const payloads = []
  const core = new WorkerCore({
    sessionId: 'session-refine-core',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter('第一遍文本'),
    vadFactory: () => scriptedVad(['speech-start', null, null, 'speech-end']),
    onSegmentFinalized: (info) => payloads.push(info)
  })

  const events = []
  for (let index = 0; index < 4; index += 1) {
    events.push(...core.ingestFrame({
      sourceId: 'mic',
      sequence: index,
      timestampSeconds: index * 0.1,
      sampleCount: FRAME,
      samples: new Float32Array(FRAME).fill(0.1)
    }))
  }

  const final = events.find((event) => event.kind === 'final')
  assert.ok(final, 'expected a final event')
  assert.equal(payloads.length, 1)
  const info = payloads[0]
  assert.equal(info.sourceId, 'mic')
  assert.equal(info.segmentId, final.segmentId)
  assert.equal(info.baseRevision, final.revision)
  assert.equal(info.t0, final.t0)
  assert.equal(info.t1, final.t1)
  const sampleCount = info.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  assert.equal(sampleCount, 4 * FRAME, 'the segment audio covers every fed frame')

  /* 脱段发射：revision 严格接在 final 之后，sequence 继续单调。 */
  const refined = core.emitRefined(info, '第二遍，带标点。')
  assert.ok(isCaptionEvent(refined))
  assert.equal(refined.kind, 'refined')
  assert.equal(refined.segmentId, final.segmentId)
  assert.equal(refined.revision, final.revision + 1)
  assert.ok(refined.sequence > final.sequence)
  assert.equal(refined.t0, final.t0)

  assert.equal(core.emitRefined({ ...info, sourceId: 'ghost' }, 'x'), null, 'unknown source must not emit')
  assert.equal(core.emitRefined(info, ''), null, 'empty refinement must not emit')
  assert.equal(core.metrics().mic.refinedEmitted, 1)
  core.dispose()
})

test('worker-core keeps no segment audio when refinement is not requested', () => {
  const core = new WorkerCore({
    sessionId: 'session-no-refine',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter('文本'),
    vadFactory: () => scriptedVad(['speech-start', 'speech-end'])
  })
  const events = []
  for (let index = 0; index < 2; index += 1) {
    events.push(...core.ingestFrame({
      sourceId: 'mic',
      sequence: index,
      timestampSeconds: index * 0.1,
      sampleCount: FRAME,
      samples: new Float32Array(FRAME).fill(0.1)
    }))
  }
  assert.ok(events.some((event) => event.kind === 'final'), 'final still flows without refinement')
  core.dispose()
})

/* 集成：真实离线模型。 */

test('offline refinement restores punctuation on the controlled corpus', { skip: skipRefine }, () => {
  const sherpa = require('sherpa-onnx-node')
  const { loadOfflineRecognizer, refineSamples } = require('../../src/runtime/refine-worker/offline-recognizer')
  const { characterErrorRate, punctuationMetrics } = require('../../scripts/gate-0b/metrics')
  const corpus = require('../../scripts/gate-0b/corpus.json')
  const reference = corpus.cases.find((item) => item.id === 'zh-en-code-switch').reference

  const recognizer = loadOfflineRecognizer({ kind: 'sherpa-offline-transducer', modelDir: REFINE_MODEL_DIR, numThreads: 3 })
  const wave = sherpa.readWave(WAV_PATH)
  const text = refineSamples(recognizer, wave.samples)
  assert.equal(characterErrorRate(reference, text), 0, `refined content must match: ${text}`)
  assert.equal(punctuationMetrics(reference, text).f1, 1, `refined punctuation must be complete: ${text}`)
})

test('realtime plus refinement full chain produces a punctuated refined caption', { skip: skipFullChain }, () => {
  const sherpa = require('sherpa-onnx-node')
  const { SileroVad } = require('../../src/runtime/realtime-worker/silero-vad')
  const { registerRecognizerAdapter } = require('../../src/runtime/realtime-worker/recognizer-adapter')
  const { SherpaOnlineRecognizerAdapter } = require('../../src/runtime/realtime-worker/sherpa-recognizer')
  const { loadOfflineRecognizer, refineSamples } = require('../../src/runtime/refine-worker/offline-recognizer')
  const { characterErrorRate, punctuationMetrics } = require('../../scripts/gate-0b/metrics')
  const corpus = require('../../scripts/gate-0b/corpus.json')
  const reference = corpus.cases.find((item) => item.id === 'zh-en-code-switch').reference

  registerRecognizerAdapter('test-refine-chain-x160', () => new SherpaOnlineRecognizerAdapter({
    kind: 'sherpa-online-transducer',
    modelDir: ASR_MODEL_DIR,
    numThreads: 4
  }))
  const refineRecognizer = loadOfflineRecognizer({ kind: 'sherpa-offline-transducer', modelDir: REFINE_MODEL_DIR, numThreads: 3 })

  const events = []
  /* 与 realtime-worker.js 的 requestRefinement→emitRefined 同构的直连回路
     （端口传输在实机 smoke 验证）。 */
  const core = new WorkerCore({
    sessionId: 'session-refine-chain',
    sourceIds: ['loopback'],
    recognizerProfile: 'test-refine-chain-x160',
    vadFactory: () => new SileroVad({ kind: 'silero', modelPath: VAD_MODEL }),
    preRollLimit: 4,
    provisionalFeedLimit: 12,
    onSegmentFinalized: (info) => {
      let sampleCount = 0
      for (const chunk of info.chunks) sampleCount += chunk.length
      const samples = new Float32Array(sampleCount)
      let offset = 0
      for (const chunk of info.chunks) { samples.set(chunk, offset); offset += chunk.length }
      const refined = core.emitRefined(info, refineSamples(refineRecognizer, samples))
      if (refined) events.push(refined)
    }
  })

  const wave = sherpa.readWave(WAV_PATH)
  let sequence = 0
  let clock = 0
  const feed = (samples) => {
    events.push(...core.ingestFrame({
      sourceId: 'loopback', sequence: sequence++, timestampSeconds: clock, sampleCount: samples.length, samples
    }))
    clock += samples.length / 16000
  }
  for (let offset = 0; offset < wave.samples.length; offset += FRAME) {
    feed(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + FRAME)))
  }
  for (let index = 0; index < 15; index += 1) feed(new Float32Array(FRAME))
  events.push(...core.flush(clock))

  for (const event of events) assert.ok(isCaptionEvent(event), `contract-invalid event: ${JSON.stringify(event)}`)
  const finals = events.filter((event) => event.kind === 'final')
  const refined = events.filter((event) => event.kind === 'refined')
  assert.ok(finals.length >= 1)
  assert.equal(refined.length, finals.length, 'every final gets a refinement in the direct loop')
  for (const event of refined) {
    const final = finals.find((item) => item.segmentId === event.segmentId)
    assert.equal(event.revision, final.revision + 1)
    assert.ok(event.sequence > final.sequence)
  }
  const joined = refined.map((event) => event.text).join(' ')
  assert.equal(characterErrorRate(reference, joined), 0, `refined content must match: ${joined}`)
  assert.equal(punctuationMetrics(reference, joined).f1, 1, `refined punctuation must be complete: ${joined}`)
  core.dispose()
})
