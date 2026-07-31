'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const {
  APPROVED_REALTIME_MODEL,
  APPROVED_REFINEMENT_MODEL
} = require('../../src/main/services/model-resolver')
const {
  activateApprovedRuntime,
  createApprovedRuntimeDefinition,
  isExternalArtifactReady
} = require('../../src/main/services/model-runtime')

const ARTIFACTS = new Map(PRODUCTION_MODEL_MANIFEST.artifacts.map((artifact) => [artifact.id, artifact]))

function tempRoot (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function installArtifact (userDataDir, artifactId) {
  const artifact = ARTIFACTS.get(artifactId)
  const root = artifact.artifactKind === 'archive'
    ? path.join(userDataDir, 'models', artifact.installId, artifact.directoryName)
    : path.join(userDataDir, 'models', artifact.installId)
  fs.mkdirSync(root, { recursive: true })
  for (const name of artifact.requiredFiles) fs.writeFileSync(path.join(root, name), 'stub')
  fs.writeFileSync(path.join(root, '.ready.json'), JSON.stringify({
    manifestVersion: PRODUCTION_MODEL_MANIFEST.version,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }))
  return root
}

class CapturingAdapter {
  constructor (options) { this.options = options }
  onCaption () { return () => {} }
}

test('runtime definition stays unavailable until the complete installed bundle is ready', (t) => {
  const root = tempRoot(t)
  const userDataDir = path.join(root, 'user-data')
  installArtifact(userDataDir, 'x-asr-160ms')
  installArtifact(userDataDir, 'silero-vad')

  assert.equal(createApprovedRuntimeDefinition({
    userDataDir,
    repoRoot: path.join(root, 'empty-repo'),
    env: {},
    Adapter: CapturingAdapter
  }), null)

  const offlineRoot = installArtifact(userDataDir, 'x-asr-offline')
  const registerAudioHostWebContents = () => () => {}
  const onAudioHostRenderProcessGone = () => {}
  const onAudioHostPreloadError = () => {}
  const onAudioHostUnresponsive = () => {}
  const onRealtimeUtilityFatal = () => {}
  const onRefineUtilityFatal = () => {}
  const definition = createApprovedRuntimeDefinition({
    userDataDir,
    repoRoot: path.join(root, 'empty-repo'),
    env: {},
    Adapter: CapturingAdapter,
    registerAudioHostWebContents,
    onAudioHostRenderProcessGone,
    onAudioHostPreloadError,
    onAudioHostUnresponsive,
    onRealtimeUtilityFatal,
    onRefineUtilityFatal
  })
  assert.equal(definition.runtimeOptions.modelOverride.id, 'x-asr-160ms')
  assert.equal(definition.runtimeOptions.modelOverride.profile, 'fast')
  assert.equal(definition.runtimeOptions.refinementAvailable, true)
  assert.equal(definition.transitionTimeoutMs, 30000)
  const adapter = definition.adapterFactory()
  assert.ok(adapter.options.recognizer.modelDir.endsWith(APPROVED_REALTIME_MODEL.directoryName))
  assert.equal(adapter.options.refinement.modelDir, offlineRoot)
  assert.equal(adapter.options.vad.kind, 'silero')
  assert.equal(adapter.options.registerAudioHostWebContents, registerAudioHostWebContents)
  assert.equal(adapter.options.onAudioHostRenderProcessGone, onAudioHostRenderProcessGone)
  assert.equal(adapter.options.onAudioHostPreloadError, onAudioHostPreloadError)
  assert.equal(adapter.options.onAudioHostUnresponsive, onAudioHostUnresponsive)
  assert.equal(adapter.options.onRealtimeUtilityFatal, onRealtimeUtilityFatal)
  assert.equal(adapter.options.onRefineUtilityFatal, onRefineUtilityFatal)
})

test('external readiness only accepts known development or explicit artifacts', (t) => {
  const root = tempRoot(t)
  const repoRoot = path.join(root, 'repo')
  const realtime = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-160', APPROVED_REALTIME_MODEL.directoryName)
  const offline = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-offline', APPROVED_REFINEMENT_MODEL.directoryName)
  const vad = path.join(repoRoot, 'models', 'vad')
  for (const [directory, artifactId] of [[realtime, 'x-asr-160ms'], [offline, 'x-asr-offline']]) {
    fs.mkdirSync(directory, { recursive: true })
    for (const name of ARTIFACTS.get(artifactId).requiredFiles) fs.writeFileSync(path.join(directory, name), 'stub')
  }
  fs.mkdirSync(vad, { recursive: true })
  fs.writeFileSync(path.join(vad, 'silero_vad.onnx'), 'stub')

  for (const id of ['x-asr-160ms', 'x-asr-offline', 'silero-vad']) {
    assert.equal(isExternalArtifactReady(id, { repoRoot, env: {} }), true)
  }
  assert.equal(isExternalArtifactReady('unknown', { repoRoot, env: {} }), false)
})

test('activation delegates an internal runtime definition to the idle coordinator', (t) => {
  const root = tempRoot(t)
  const userDataDir = path.join(root, 'user-data')
  for (const id of ['x-asr-160ms', 'x-asr-offline', 'silero-vad']) installArtifact(userDataDir, id)
  let received = null
  const result = activateApprovedRuntime({
    coordinator: {
      replaceRuntime (definition) {
        received = definition
        return { phase: 'idle', model: { state: 'ready' } }
      }
    },
    userDataDir,
    repoRoot: path.join(root, 'empty-repo'),
    env: {},
    Adapter: CapturingAdapter
  })
  assert.equal(result.phase, 'idle')
  assert.equal(received.runtimeOptions.modelOverride.developmentOnly, false)
  assert.equal(JSON.stringify(received.runtimeOptions).includes(userDataDir), false)
})
