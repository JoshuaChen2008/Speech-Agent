'use strict'

// @ts-check

const MANIFEST_VERSION = 1
const RESOURCE_GROUPS = Object.freeze(['core', 'refinement'])

const REALTIME_DIRECTORY = 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
const REFINEMENT_DIRECTORY = 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03'
const REALTIME_FILES = Object.freeze(['tokens.txt', 'encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx'])
const REFINEMENT_FILES = Object.freeze([
  'tokens.txt',
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.onnx',
  'joiner-epoch-99-avg-1.int8.onnx'
])

function deepFreeze (value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const PRODUCTION_MODEL_MANIFEST = deepFreeze({
  version: MANIFEST_VERSION,
  artifacts: [
    {
      id: 'x-asr-160ms',
      resourceGroup: 'core',
      artifactKind: 'archive',
      installId: 'x-asr-160ms',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2',
      bytes: 133898007,
      sha256: '8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399',
      directoryName: REALTIME_DIRECTORY,
      requiredFiles: [...REALTIME_FILES],
      upstream: {
        project: 'k2-fsa/sherpa-onnx',
        release: 'asr-models',
        asset: 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2'
      }
    },
    {
      id: 'x-asr-offline',
      resourceGroup: 'refinement',
      artifactKind: 'archive',
      installId: 'x-asr-offline',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03.tar.bz2',
      bytes: 136396739,
      sha256: '5d02c36d7b44e886b7c8f0d8e051f8713acab96c264bb6ef9e718be39a6a2224',
      directoryName: REFINEMENT_DIRECTORY,
      requiredFiles: [...REFINEMENT_FILES],
      upstream: {
        project: 'k2-fsa/sherpa-onnx',
        release: 'asr-models',
        asset: 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03.tar.bz2'
      }
    },
    {
      id: 'silero-vad',
      resourceGroup: 'core',
      artifactKind: 'file',
      installId: 'silero-vad',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      bytes: 643854,
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
      fileName: 'silero_vad.onnx',
      requiredFiles: ['silero_vad.onnx'],
      upstream: {
        project: 'k2-fsa/sherpa-onnx',
        release: 'asr-models',
        asset: 'silero_vad.onnx'
      }
    }
  ]
})

const SAFE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/
const SHA256 = /^[a-f0-9]{64}$/

function invalidManifest () {
  const error = new TypeError('invalid model manifest')
  error.code = 'INVALID_MANIFEST'
  return error
}

/** Validate and detach an injected manifest. Unknown data is not retained. */
function validateManifest (input) {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.version) || input.version < 1 || !Array.isArray(input.artifacts) || input.artifacts.length < 1) {
    throw invalidManifest()
  }
  const seen = new Set()
  const artifacts = input.artifacts.map((raw) => {
    if (!raw || typeof raw !== 'object' || !SAFE_COMPONENT.test(raw.id) || seen.has(raw.id) || !SAFE_COMPONENT.test(raw.installId)) throw invalidManifest()
    seen.add(raw.id)
    if (raw.artifactKind !== 'archive' && raw.artifactKind !== 'file') throw invalidManifest()
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 1 || !SHA256.test(raw.sha256)) throw invalidManifest()
    let parsed
    try { parsed = new URL(raw.url) } catch { throw invalidManifest() }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw invalidManifest()
    if (!Array.isArray(raw.requiredFiles) || raw.requiredFiles.length < 1 || raw.requiredFiles.some((name) => typeof name !== 'string' || !SAFE_COMPONENT.test(name))) throw invalidManifest()
    if (!raw.upstream || typeof raw.upstream !== 'object' || typeof raw.upstream.project !== 'string' || typeof raw.upstream.release !== 'string' || typeof raw.upstream.asset !== 'string') throw invalidManifest()
    const artifact = {
      id: raw.id,
      resourceGroup: raw.resourceGroup === undefined ? 'core' : raw.resourceGroup,
      artifactKind: raw.artifactKind,
      installId: raw.installId,
      url: parsed.toString(),
      bytes: raw.bytes,
      sha256: raw.sha256,
      requiredFiles: [...raw.requiredFiles],
      upstream: {
        project: raw.upstream.project,
        release: raw.upstream.release,
        asset: raw.upstream.asset
      }
    }
    if (!RESOURCE_GROUPS.includes(artifact.resourceGroup)) throw invalidManifest()
    if (raw.artifactKind === 'archive') {
      if (!SAFE_COMPONENT.test(raw.directoryName)) throw invalidManifest()
      artifact.directoryName = raw.directoryName
    } else {
      if (!SAFE_COMPONENT.test(raw.fileName) || raw.requiredFiles.length !== 1 || raw.requiredFiles[0] !== raw.fileName) throw invalidManifest()
      artifact.fileName = raw.fileName
    }
    return artifact
  })
  return deepFreeze({ version: input.version, artifacts })
}

module.exports = {
  MANIFEST_VERSION,
  PRODUCTION_MODEL_MANIFEST,
  RESOURCE_GROUPS,
  deepFreeze,
  validateManifest
}
