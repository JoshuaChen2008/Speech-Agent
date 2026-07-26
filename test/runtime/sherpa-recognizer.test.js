'use strict'

/* 真实模型集成测试（模型轨）。
   依赖本机被忽略的 Gate 0B 资产（160ms 模型四件套 + 受控语料 WAV）与
   sherpa-onnx 原生绑定；缺任何一样即整体 skip——CI/干净机上套件保持全绿，
   有资产的开发机上则以真实推理验证 adapter 契约与 worker-core 管线。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MODEL_DIR = path.resolve(
  __dirname,
  '../../models/gate-0b/extracted/x-asr-160/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
)
const WAV_PATH = path.resolve(__dirname, '../../models/gate-0b/corpus/zh-en-code-switch.wav')
const REQUIRED_FILES = ['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx']

function sherpaLoadable () {
  try {
    require.resolve('sherpa-onnx-node')
    return true
  } catch {
    return false
  }
}

const assetsPresent = REQUIRED_FILES.every((name) => fs.existsSync(path.join(MODEL_DIR, name))) &&
  fs.existsSync(WAV_PATH)
const skip = (!assetsPresent || !sherpaLoadable()) && 'local Gate 0B model assets or sherpa-onnx binding missing'

const FRAME_SAMPLES = 1600 // 100ms @ 16k，与 audio host 帧尺寸一致

test('approved 160ms model yields contract-valid captions through the worker core', { skip }, () => {
  const sherpa = require('sherpa-onnx-node')
  const { WorkerCore, SAMPLE_RATE } = require('../../src/runtime/realtime-worker/worker-core')
  const { registerSherpaRecognizer } = require('../../src/runtime/realtime-worker/sherpa-recognizer')
  const { isCaptionEvent } = require('../../src/contracts')
  const { characterErrorRate } = require('../../scripts/gate-0b/metrics')
  const corpus = require('../../scripts/gate-0b/corpus.json')
  const reference = corpus.cases.find((item) => item.id === 'zh-en-code-switch').reference

  /* 测试专用 profile 名：套件单进程运行，注册表是全局的。 */
  registerSherpaRecognizer('test-x-asr-160', {
    kind: 'sherpa-online-transducer',
    modelDir: MODEL_DIR,
    numThreads: 4
  })

  const core = new WorkerCore({
    sessionId: 'session-sherpa-integration',
    sourceIds: ['loopback'],
    recognizerProfile: 'test-x-asr-160'
  })

  const wave = sherpa.readWave(WAV_PATH)
  assert.equal(wave.sampleRate, SAMPLE_RATE)

  const events = []
  let sequence = 0
  let clockSeconds = 0
  const feedSamples = (samples) => {
    events.push(...core.ingestFrame({
      sourceId: 'loopback',
      sequence: sequence++,
      timestampSeconds: clockSeconds,
      sampleCount: samples.length,
      samples
    }))
    clockSeconds += samples.length / SAMPLE_RATE
  }
  const feedWave = () => {
    for (let offset = 0; offset < wave.samples.length; offset += FRAME_SAMPLES) {
      feedSamples(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + FRAME_SAMPLES)))
    }
  }
  const feedSilence = (frames) => {
    for (let index = 0; index < frames; index += 1) feedSamples(new Float32Array(FRAME_SAMPLES))
  }

  /* 同一 WAV 播两遍、之间静音收段：验证 endSegment 后 stream 重建可用
     （inputFinished 的 stream 不可复用是 sherpa 的硬约束）。占位 EnergyVad
     默认 0.5s 停顿即收段，SAPI 语音会被切成多个碎片段——分段粒度是 VAD
     轨的议题，本测试对它保持鲁棒，只锁模型输出的内容正确性。 */
  feedWave()
  feedSilence(8)
  feedWave()
  feedSilence(8)
  events.push(...core.flush(clockSeconds))

  const partials = events.filter((event) => event.kind === 'partial')
  const finals = events.filter((event) => event.kind === 'final')
  assert.ok(partials.length >= 2, `expected streaming partials, got ${partials.length}`)
  assert.ok(finals.length >= 2, `expected finalized segments from both playbacks, got ${finals.length}`)

  for (const event of events) {
    assert.ok(isCaptionEvent(event), `contract-invalid event: ${JSON.stringify(event)}`)
  }
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].sequence > events[index - 1].sequence, 'caption sequence must increase')
  }
  assert.equal(new Set(finals.map((event) => event.segmentId)).size, finals.length, 'segment ids must be unique')

  /* 内容门槛：与 Gate 0B 同一 CER 口径（忽略大小写/空白/标点），对按序
     拼接的全部定稿计算——吸收 VAD 分段边界的少量切字损耗（实测约 0.06），
     仍足以在模型接错文件/喂错采样率时立刻失败。 */
  const joined = finals.map((event) => event.text).join(' ')
  const cer = characterErrorRate(reference + reference, joined)
  assert.ok(cer < 0.15, `joined final CER ${cer} too high: ${joined}`)

  core.dispose()
})

test('sherpa adapter interface honors segment lifecycle and disposal', { skip }, () => {
  const { SherpaOnlineRecognizerAdapter } = require('../../src/runtime/realtime-worker/sherpa-recognizer')
  const adapter = new SherpaOnlineRecognizerAdapter({
    kind: 'sherpa-online-transducer',
    modelDir: MODEL_DIR,
    numThreads: 4
  })

  /* 无帧时的空段：poll/endSegment 不得抛错。 */
  assert.equal(adapter.poll(), null)
  assert.equal(adapter.endSegment(), null)

  adapter.acceptFrame(new Float32Array(FRAME_SAMPLES))
  assert.equal(typeof adapter.poll(), 'string')
  const silentFinal = adapter.endSegment()
  assert.ok(silentFinal === null || silentFinal === '', 'pure silence must not produce text')

  adapter.dispose()
  adapter.acceptFrame(new Float32Array(FRAME_SAMPLES))
  assert.equal(adapter.poll(), null)
  assert.equal(adapter.endSegment(), null)
})

test('recognizer option validation rejects malformed configurations', () => {
  const { assertRecognizerOptions } = require('../../src/runtime/realtime-worker/sherpa-recognizer')
  assert.throws(() => assertRecognizerOptions(null), /required/)
  assert.throws(() => assertRecognizerOptions({ kind: 'other', modelDir: 'x' }), /unsupported/)
  assert.throws(() => assertRecognizerOptions({ kind: 'sherpa-online-transducer', modelDir: '' }), /modelDir/)
  assert.throws(() => assertRecognizerOptions({ kind: 'sherpa-online-transducer', modelDir: 'x', numThreads: 0 }), /numThreads/)
  const normalized = assertRecognizerOptions({ kind: 'sherpa-online-transducer', modelDir: 'x' })
  assert.equal(normalized.numThreads, 4)
  assert.equal(normalized.modelType, 'zipformer2')
  assert.ok(Object.isFrozen(normalized))
})
