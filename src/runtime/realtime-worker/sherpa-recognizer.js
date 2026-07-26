'use strict'

// @ts-check

/* 真实 recognizer adapter（模型轨，Gate 0B 2026-07-27 改判后接入）。
   --------------------------------------------------------------------------
   实现 recognizer-adapter 契约（acceptFrame/poll/endSegment/dispose），
   内部是 sherpa-onnx N-API 的流式 OnlineRecognizer（transducer 三件套）。
   与 Gate 0B streaming-bench 同方法学：greedy_search、endpoint 关闭
   （v1 分段由 VAD speech-end 主导，见 PLAN §5.3）、段收束时喂 0.4s 静音尾
   并 inputFinished 冲刷模型 lookahead，否则句尾 token 出不来。

   资源模型：
   - OnlineRecognizer 按 modelDir+numThreads 在模块级共享——同一 worker 内
     双 source 各自 adapter，但 encoder（int8 约 155MB）只载入一次；
     stream 才是 per-adapter/per-segment 状态。
   - inputFinished 后的 stream 不可复用：endSegment 即废弃，下一段
     acceptFrame 时懒建新 stream。
   - dispose 只丢 stream 引用；共享 recognizer 随 utilityProcess 退出释放
     （worker 与会话同生命周期，B2.3 拓扑）。

   本模块只应在 configure 携带真实 recognizer 选项时被 require——
   结构模式（null profile）不得加载原生模块。 */

const fs = require('node:fs')
const path = require('node:path')

const { registerRecognizerAdapter } = require('./recognizer-adapter')

const SAMPLE_RATE = 16000
const TAIL_SILENCE_SECONDS = 0.4

/** @type {*} sherpa-onnx-node 懒加载缓存（原生模块，加载即有成本） */
let sherpaModule = null
function sherpa () {
  if (!sherpaModule) sherpaModule = require('sherpa-onnx-node')
  return sherpaModule
}

/** @type {Map<string, *>} 共享 recognizer：`${modelDir}|${numThreads}` → OnlineRecognizer */
const recognizerCache = new Map()

function resolveModelFile (modelDir, preferredName, fallbackPattern) {
  const preferredPath = path.join(modelDir, preferredName)
  if (fs.existsSync(preferredPath)) return preferredPath
  const matches = fs.readdirSync(modelDir).filter((name) => fallbackPattern.test(name)).sort()
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${fallbackPattern} in the model directory, found ${matches.length}`)
  }
  return path.join(modelDir, matches[0])
}

function assertRecognizerOptions (options) {
  if (!options || typeof options !== 'object') throw new TypeError('recognizer options are required')
  if (options.kind !== 'sherpa-online-transducer') {
    throw new TypeError(`unsupported recognizer kind: ${String(options.kind)}`)
  }
  if (typeof options.modelDir !== 'string' || options.modelDir.length === 0) {
    throw new TypeError('recognizer modelDir is required')
  }
  /* 上限只是防呆；生产值由 model-resolver 按改判决定固定为 4——
     改判记录明确 numThreads>=6 在混合架构上反噬，不得使用。 */
  const numThreads = options.numThreads === undefined ? 4 : options.numThreads
  if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > 16) {
    throw new TypeError('recognizer numThreads must be an integer between 1 and 16')
  }
  return Object.freeze({
    kind: options.kind,
    modelDir: options.modelDir,
    numThreads,
    modelType: typeof options.modelType === 'string' && options.modelType.length > 0 ? options.modelType : 'zipformer2'
  })
}

/** 共享载入；同参数幂等。载入是同步重操作（int8 encoder 秒级），调用方
    （worker configure）应在回 'configured' 前完成，让超时语义覆盖它。 */
function loadSharedRecognizer (rawOptions) {
  const options = assertRecognizerOptions(rawOptions)
  const key = `${options.modelDir}|${options.numThreads}|${options.modelType}`
  let recognizer = recognizerCache.get(key)
  if (!recognizer) {
    const tokens = path.join(options.modelDir, 'tokens.txt')
    if (!fs.existsSync(tokens)) throw new Error('recognizer model directory is missing tokens.txt')
    recognizer = new (sherpa().OnlineRecognizer)({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: resolveModelFile(options.modelDir, 'encoder.int8.onnx', /^encoder.*\.onnx$/),
          decoder: resolveModelFile(options.modelDir, 'decoder.onnx', /^decoder.*\.onnx$/),
          joiner: resolveModelFile(options.modelDir, 'joiner.int8.onnx', /^joiner.*\.onnx$/)
        },
        tokens,
        numThreads: options.numThreads,
        provider: 'cpu',
        modelType: options.modelType
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: 0
    })
    recognizerCache.set(key, recognizer)
  }
  return { recognizer, options }
}

class SherpaOnlineRecognizerAdapter {
  constructor (rawOptions) {
    const { recognizer } = loadSharedRecognizer(rawOptions)
    this.recognizer = recognizer
    this.stream = null
    this.disposed = false
  }

  ensureStream () {
    if (!this.stream) this.stream = this.recognizer.createStream()
    return this.stream
  }

  /** @param {Float32Array} samples 一帧 16k mono PCM */
  acceptFrame (samples) {
    if (this.disposed) return
    this.ensureStream().acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
  }

  poll () {
    if (this.disposed || !this.stream) return null
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const text = this.recognizer.getResult(this.stream).text
    return typeof text === 'string' ? text.trim() : null
  }

  endSegment () {
    if (this.disposed || !this.stream) return null
    const stream = this.stream
    this.stream = null
    /* 静音尾 + inputFinished：冲刷流式模型的右上下文，句尾 token 才齐；
       与 Gate 0B 基准同参数（0.4s）。之后该 stream 废弃。 */
    stream.acceptWaveform({
      samples: new Float32Array(Math.round(SAMPLE_RATE * TAIL_SILENCE_SECONDS)),
      sampleRate: SAMPLE_RATE
    })
    stream.inputFinished()
    while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
    const text = this.recognizer.getResult(stream).text
    return typeof text === 'string' ? text.trim() : null
  }

  dispose () {
    this.disposed = true
    this.stream = null
  }
}

/** worker configure 用：把真实 recognizer 注册到 profile 注册表。
    先同步载入模型再注册——'configured' 回执因此意味着模型已就绪。 */
function registerSherpaRecognizer (profile, rawOptions) {
  const { options } = loadSharedRecognizer(rawOptions)
  registerRecognizerAdapter(profile, () => new SherpaOnlineRecognizerAdapter(options))
}

module.exports = {
  SherpaOnlineRecognizerAdapter,
  assertRecognizerOptions,
  loadSharedRecognizer,
  registerSherpaRecognizer
}
