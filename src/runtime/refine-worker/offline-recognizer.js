'use strict'

// @ts-check

/* 精修用离线识别器（Gate 0B 改判批准的离线 X-ASR transducer）。
   纯封装：载入与单次解码，不含进程/端口接线（那些在 refine-worker.js），
   因此可以在 node:test 里直接对本机模型做集成测试。
   与 M3 评估同方法学：greedy_search、CPU、numThreads 由改判配置固定（3）。 */

const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 16000

/** @type {*} */
let sherpaModule = null
function sherpa () {
  if (!sherpaModule) sherpaModule = require('sherpa-onnx-node')
  return sherpaModule
}

function resolveModelFile (modelDir, preferredName, fallbackPattern) {
  const preferredPath = path.join(modelDir, preferredName)
  if (fs.existsSync(preferredPath)) return preferredPath
  const matches = fs.readdirSync(modelDir).filter((name) => fallbackPattern.test(name)).sort()
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${fallbackPattern} in the refinement model directory, found ${matches.length}`)
  }
  return path.join(modelDir, matches[0])
}

function assertRefinementOptions (options) {
  if (!options || typeof options !== 'object') throw new TypeError('refinement options are required')
  if (options.kind !== 'sherpa-offline-transducer') {
    throw new TypeError(`unsupported refinement kind: ${String(options.kind)}`)
  }
  if (typeof options.modelDir !== 'string' || options.modelDir.length === 0) {
    throw new TypeError('refinement modelDir is required')
  }
  const numThreads = options.numThreads === undefined ? 3 : options.numThreads
  if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > 16) {
    throw new TypeError('refinement numThreads must be an integer between 1 and 16')
  }
  return Object.freeze({ kind: options.kind, modelDir: options.modelDir, numThreads })
}

/** 同步载入（int8 encoder 秒级）；调用方（refine worker configure）应在回
    'configured' 前完成，让宿主超时覆盖它。 */
function loadOfflineRecognizer (rawOptions) {
  const options = assertRefinementOptions(rawOptions)
  return new (sherpa().OfflineRecognizer)({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: resolveModelFile(options.modelDir, 'encoder-epoch-99-avg-1.int8.onnx', /^encoder.*\.onnx$/),
        decoder: resolveModelFile(options.modelDir, 'decoder-epoch-99-avg-1.onnx', /^decoder.*\.onnx$/),
        joiner: resolveModelFile(options.modelDir, 'joiner-epoch-99-avg-1.int8.onnx', /^joiner.*\.onnx$/)
      },
      tokens: path.join(options.modelDir, 'tokens.txt'),
      numThreads: options.numThreads,
      provider: 'cpu'
    },
    decodingMethod: 'greedy_search'
  })
}

/**
 * 对一段 16k mono 音频做一次完整离线识别。
 * @param {*} recognizer loadOfflineRecognizer 的返回值
 * @param {Float32Array} samples
 * @returns {string} 定稿文本（已 trim；空串表示无内容）
 */
function refineSamples (recognizer, samples) {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
  recognizer.decode(stream)
  const text = recognizer.getResult(stream).text
  return typeof text === 'string' ? text.trim() : ''
}

module.exports = { SAMPLE_RATE, assertRefinementOptions, loadOfflineRecognizer, refineSamples }
