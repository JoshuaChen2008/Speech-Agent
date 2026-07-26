'use strict'

// @ts-check

/* 已批准 realtime 模型的本地解析（Gate 0B 2026-07-27 改判后、B4 ModelManager
   之前的最小实现）。只解析改判批准的那一个模型；找不到就返回 null——
   capabilities 保持不可用，绝不伪造 profile。

   查找顺序（先到先得）：
   1. LIVE_SUBTITLE_MODEL_DIR 环境变量：直接指向模型目录（含四件套）。
   2. <userData>/models/<id>/<官方目录名> 与 <userData>/models/<id>：
      未来 ModelManager 的安装位，先行兼容。
   3. 仓库开发布局 models/gate-0b/extracted/x-asr-160/<官方目录名>：
      Gate 0B 实测解包的位置（忽略目录，仅开发机存在）。

   注意：numThreads=4 与 fast profile 是改判决定的一部分
   （docs/validation/gate-0b-results.json 的 rejudgment 块），不是可调偏好。 */

const fs = require('node:fs')
const path = require('node:path')

const MODEL_DIR_ENV = 'LIVE_SUBTITLE_MODEL_DIR'

const APPROVED_REALTIME_MODEL = Object.freeze({
  id: 'x-asr-160ms',
  profile: 'fast',
  kind: 'sherpa-online-transducer',
  numThreads: 4,
  modelType: 'zipformer2',
  directoryName: 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
})

const REQUIRED_FILES = Object.freeze(['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx'])

function hasRequiredFiles (directory) {
  try {
    return REQUIRED_FILES.every((name) => fs.statSync(path.join(directory, name)).isFile())
  } catch {
    return false
  }
}

/**
 * @param {{ env?: *, userDataDir?: string | null, repoRoot?: string }} [options]
 * @returns {{ id: string, profile: string, kind: string, numThreads: number, modelType: string, modelDir: string } | null}
 */
function resolveApprovedRealtimeModel (options = {}) {
  const env = options.env || process.env
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..', '..')
  const model = APPROVED_REALTIME_MODEL
  const candidates = []
  const explicit = env[MODEL_DIR_ENV]
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit)
  if (typeof options.userDataDir === 'string' && options.userDataDir.length > 0) {
    candidates.push(path.join(options.userDataDir, 'models', model.id, model.directoryName))
    candidates.push(path.join(options.userDataDir, 'models', model.id))
  }
  candidates.push(path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-160', model.directoryName))

  for (const candidate of candidates) {
    if (hasRequiredFiles(candidate)) {
      return Object.freeze({
        id: model.id,
        profile: model.profile,
        kind: model.kind,
        numThreads: model.numThreads,
        modelType: model.modelType,
        modelDir: candidate
      })
    }
  }
  return null
}

module.exports = {
  APPROVED_REALTIME_MODEL,
  MODEL_DIR_ENV,
  REQUIRED_FILES,
  resolveApprovedRealtimeModel
}
