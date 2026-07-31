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
const { PRODUCTION_MODEL_MANIFEST } = require('./model-manifest')

const ARTIFACTS = new Map(PRODUCTION_MODEL_MANIFEST.artifacts.map((artifact) => [artifact.id, artifact]))
const REALTIME_ARTIFACT = ARTIFACTS.get('x-asr-160ms')
const REFINEMENT_ARTIFACT = ARTIFACTS.get('x-asr-offline')
const VAD_ARTIFACT = ARTIFACTS.get('silero-vad')

if (!REALTIME_ARTIFACT || !REFINEMENT_ARTIFACT || !VAD_ARTIFACT) {
  throw new Error('production model manifest is incomplete')
}

const MODEL_DIR_ENV = 'LIVE_SUBTITLE_MODEL_DIR'

const APPROVED_REALTIME_MODEL = Object.freeze({
  id: 'x-asr-160ms',
  profile: 'fast',
  kind: 'sherpa-online-transducer',
  numThreads: 4,
  modelType: 'zipformer2',
  directoryName: REALTIME_ARTIFACT.directoryName
})

const REQUIRED_FILES = Object.freeze([...REALTIME_ARTIFACT.requiredFiles])

function hasRequiredFiles (directory) {
  try {
    return REQUIRED_FILES.every((name) => fs.statSync(path.join(directory, name)).isFile())
  } catch {
    return false
  }
}

function hasInstalledArtifact (directory, artifact) {
  try {
    const rootStat = fs.lstatSync(directory)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const markerPath = path.join(directory, '.ready.json')
    const markerStat = fs.lstatSync(markerPath)
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return false
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const keys = Object.keys(marker).sort()
    if (keys.join(',') !== 'artifactId,bytes,manifestVersion,sha256') return false
    if (marker.manifestVersion !== PRODUCTION_MODEL_MANIFEST.version ||
        marker.artifactId !== artifact.id ||
        marker.sha256 !== artifact.sha256 ||
        marker.bytes !== artifact.bytes) return false

    const rootReal = fs.realpathSync(directory)
    return artifact.requiredFiles.every((name) => {
      const candidate = path.join(directory, name)
      const stat = fs.lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) return false
      const relative = path.relative(rootReal, fs.realpathSync(candidate))
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
  } catch {
    return false
  }
}

/**
 * @param {{ env?: *, userDataDir?: string | null, repoRoot?: string, allowExternal?: boolean }} [options]
 * @returns {{ id: string, profile: string, kind: string, numThreads: number, modelType: string, modelDir: string } | null}
 */
function resolveApprovedRealtimeModel (options = {}) {
  const env = options.env || process.env
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..', '..')
  const allowExternal = options.allowExternal !== false
  const model = APPROVED_REALTIME_MODEL
  const explicit = env[MODEL_DIR_ENV]
  if (allowExternal && typeof explicit === 'string' && explicit.length > 0 && hasRequiredFiles(explicit)) {
    return resolvedRealtime(explicit, model)
  }
  if (typeof options.userDataDir === 'string' && options.userDataDir.length > 0) {
    const installed = path.join(options.userDataDir, 'models', model.id, model.directoryName)
    if (hasInstalledArtifact(installed, REALTIME_ARTIFACT)) return resolvedRealtime(installed, model)
  }
  if (allowExternal) {
    const development = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-160', model.directoryName)
    if (hasRequiredFiles(development)) return resolvedRealtime(development, model)
  }
  return null
}

function resolvedRealtime (modelDir, model) {
  return Object.freeze({
    id: model.id,
    profile: model.profile,
    kind: model.kind,
    numThreads: model.numThreads,
    modelType: model.modelType,
    modelDir
  })
}

const REFINE_MODEL_DIR_ENV = 'LIVE_SUBTITLE_REFINE_MODEL_DIR'

const APPROVED_REFINEMENT_MODEL = Object.freeze({
  id: 'x-asr-offline',
  kind: 'sherpa-offline-transducer',
  /* numThreads=3 与 M3 评估/改判证据同配置（RTF 0.027），不是可调偏好。 */
  numThreads: 3,
  directoryName: REFINEMENT_ARTIFACT.directoryName
})

const REFINEMENT_REQUIRED_FILES = Object.freeze([...REFINEMENT_ARTIFACT.requiredFiles])

function hasFiles (directory, files) {
  try {
    return files.every((name) => fs.statSync(path.join(directory, name)).isFile())
  } catch {
    return false
  }
}

/**
 * 改判批准的离线精修模型解析（env → userData → 仓库开发布局）。
 * 找不到返回 null——精修保持关闭（canRefine=false），实时字幕不受影响。
 * @param {{ env?: *, userDataDir?: string | null, repoRoot?: string, allowExternal?: boolean }} [options]
 * @returns {{ id: string, kind: string, numThreads: number, modelDir: string } | null}
 */
function resolveApprovedRefinementModel (options = {}) {
  const env = options.env || process.env
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..', '..')
  const allowExternal = options.allowExternal !== false
  const model = APPROVED_REFINEMENT_MODEL
  const explicit = env[REFINE_MODEL_DIR_ENV]
  if (allowExternal && typeof explicit === 'string' && explicit.length > 0 && hasFiles(explicit, REFINEMENT_REQUIRED_FILES)) {
    return resolvedRefinement(explicit, model)
  }
  if (typeof options.userDataDir === 'string' && options.userDataDir.length > 0) {
    const installed = path.join(options.userDataDir, 'models', model.id, model.directoryName)
    if (hasInstalledArtifact(installed, REFINEMENT_ARTIFACT)) return resolvedRefinement(installed, model)
  }
  if (allowExternal) {
    const development = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-offline', model.directoryName)
    if (hasFiles(development, REFINEMENT_REQUIRED_FILES)) return resolvedRefinement(development, model)
  }
  return null
}

function resolvedRefinement (modelDir, model) {
  return Object.freeze({ id: model.id, kind: model.kind, numThreads: model.numThreads, modelDir })
}

const VAD_MODEL_ENV = 'LIVE_SUBTITLE_VAD_MODEL'
const VAD_MODEL_FILE = 'silero_vad.onnx'

/**
 * silero VAD 模型解析（与 realtime 模型同序：env → userData → 仓库开发布局）。
 * 找不到返回 null——调用方回退 EnergyVad 并警告，不阻塞字幕，但分段质量
 * 降级（能量占位对音量敏感、纯音也当人声）。
 * @param {{ env?: *, userDataDir?: string | null, repoRoot?: string, allowExternal?: boolean }} [options]
 * @returns {{ kind: string, modelPath: string } | null}
 */
function resolveSileroVadModel (options = {}) {
  const env = options.env || process.env
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..', '..')
  const allowExternal = options.allowExternal !== false
  const candidates = []
  const explicit = env[VAD_MODEL_ENV]
  if (allowExternal && typeof explicit === 'string' && explicit.length > 0) {
    candidates.push({ path: explicit, installed: false })
  }
  if (typeof options.userDataDir === 'string' && options.userDataDir.length > 0) {
    candidates.push({
      path: path.join(options.userDataDir, 'models', 'silero-vad', VAD_MODEL_FILE),
      installed: true
    })
  }
  if (allowExternal) {
    candidates.push({ path: path.join(repoRoot, 'models', 'vad', VAD_MODEL_FILE), installed: false })
  }

  for (const candidate of candidates) {
    try {
      const accepted = candidate.installed
        ? hasInstalledArtifact(path.dirname(candidate.path), VAD_ARTIFACT)
        : fs.statSync(candidate.path).isFile()
      if (accepted) return Object.freeze({ kind: 'silero', modelPath: candidate.path })
    } catch { /* try next */ }
  }
  return null
}

module.exports = {
  APPROVED_REALTIME_MODEL,
  APPROVED_REFINEMENT_MODEL,
  MODEL_DIR_ENV,
  REFINE_MODEL_DIR_ENV,
  REFINEMENT_REQUIRED_FILES,
  REQUIRED_FILES,
  VAD_MODEL_ENV,
  resolveApprovedRealtimeModel,
  resolveApprovedRefinementModel,
  resolveSileroVadModel
}
