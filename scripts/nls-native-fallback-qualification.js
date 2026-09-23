'use strict'

// Explicit opt-in, read-only corpus/native qualification. No capture or cloud connection.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { WorkerCore } = require('../src/runtime/realtime-worker/worker-core')
const { CloudAudioBuffer } = require('../src/runtime/recognition/cloud-audio-buffer')
const { createTwoStageRecognizerAdapter } = require('../src/runtime/realtime-worker/recognizer-adapter')
const { parsePcm16MonoWav } = require('./native-model-activity-support')
const { FIXTURE_SHA256 } = require('./verify-native-model-activity-lifecycle-report')
const ROOT = path.resolve(__dirname, '..')
function digest (bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function assets () {
  const authoritative = path.join(ROOT, 'models/gate-0b/extracted/x-asr-160/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05')
  const draft = path.join(ROOT, 'models/gate-0b/extracted/replacement-candidates/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20')
  const vad = path.join(ROOT, 'models/vad/silero_vad.onnx')
  const corpus = path.join(ROOT, 'models/gate-0b/corpus/zh-en-code-switch.wav')
  const files = [vad, corpus, ...['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'].map(n => path.join(authoritative, n)), ...['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt'].map(n => path.join(draft, n))]
  if (files.some(file => !fs.existsSync(file))) throw new Error('NLS_NATIVE_ASSETS_MISSING')
  const bytes = fs.readFileSync(corpus)
  if (digest(bytes) !== FIXTURE_SHA256) throw new Error('NLS_NATIVE_FIXTURE_MISMATCH')
  return { authoritative, draft, vad, bytes, modelDigest: digest(Buffer.from(files.filter(f => f !== corpus).map(f => digest(fs.readFileSync(f))).join(''))) }
}
async function qualify () {
  const input = assets()
  const { SherpaOnlineRecognizerAdapter } = require('../src/runtime/realtime-worker/sherpa-recognizer')
  const { SileroVad } = require('../src/runtime/realtime-worker/silero-vad')
  const samples = parsePcm16MonoWav(input.bytes).samples
  const cases = []
  for (const cutSample of [0, 800]) {
    const events = []; const faults = []
    const core = new WorkerCore({ sessionId: 'native-fallback', sourceIds: ['mic'],
      provisionalRecognizerFeed: true,
      adapterFactory: () => createTwoStageRecognizerAdapter({
        createDraft: () => new SherpaOnlineRecognizerAdapter({ kind: 'sherpa-online-transducer', modelDir: input.draft, modelType: 'zipformer', numThreads: 4 }),
        createAuthoritative: () => new SherpaOnlineRecognizerAdapter({ kind: 'sherpa-online-transducer', modelDir: input.authoritative, numThreads: 4 }),
        onDraftFault: () => faults.push('DRAFT_FAILED') }),
      vadFactory: () => new SileroVad({ kind: 'silero', modelPath: input.vad }) })
    let sentFrames = 0
    const buffer = new CloudAudioBuffer({ core, send: message => { sentFrames++; buffer.acknowledge(message.id) }, emit: e => events.push(e), fault: code => faults.push(code) })
    try {
      let sequence = 0
      for (let offset = 0; offset < samples.length + 32000; offset += 1600) {
        const frame = new Float32Array(1600)
        if (offset < samples.length) frame.set(samples.subarray(offset, Math.min(samples.length, offset + 1600)))
        buffer.ingestFrame({ sourceId: 'mic', sequence: sequence++, timestampSeconds: offset / 16000, sampleCount: frame.length, samples: frame })
      }
      const decodedBeforeHandoff = core.sources.get('mic').metricsState.framesIngested
      // Cloud connection failure is the external boundary; only the sample cut crosses it.
      buffer.commit(cutSample); buffer.takeover(cutSample)
      await buffer.end()
      const final = events.filter(e => e.kind === 'final')
      const partial = events.filter(e => e.kind === 'partial')
      const result = { cutSample, sentFrames, decodedBeforeHandoff, finalCount: final.length, partialCount: partial.length,
        faultCount: faults.length, released: buffer.frames.length === 0 && buffer.pendingSamples === 0,
        transcriptSha256: digest(Buffer.from(final.map(e => e.text).join('\n'))) }
      if (decodedBeforeHandoff !== 0 || !result.finalCount || !result.partialCount || faults.length || !result.released) throw new Error('NLS_NATIVE_ASSERTION_FAILED')
      cases.push(result)
    } finally { buffer.dispose(); core.dispose() }
  }
  return { schemaVersion: 1, result: 'pass', gateStatus: 'diagnostic-only', realCapture: false, realCloud: false,
    realNativeRecognition: true, fixtureSha256: FIXTURE_SHA256, modelSha256: input.modelDigest, cases }
}
if (require.main === module) {
  const target = process.argv[2] && path.resolve(process.argv[2])
  const relative = target && path.relative(path.join(ROOT, '.artifacts'), target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(target) !== '.json') process.exitCode = 2
  else qualify().then(report => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ result: report.result, cases: report.cases.length })) }).catch(() => { console.error('NLS_NATIVE_QUALIFICATION_FAILED'); process.exitCode = 1 })
}
module.exports = { qualify }
