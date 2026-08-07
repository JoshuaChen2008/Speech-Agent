'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const {
  APPROVED_DRAFT_MODEL,
  APPROVED_REALTIME_MODEL,
  APPROVED_REFINEMENT_MODEL,
  DRAFT_MODEL_DIR_ENV,
  MODEL_DIR_ENV,
  REFINE_MODEL_DIR_ENV,
  VAD_MODEL_ENV
} = require('../../src/main/services/model-resolver')
const {
  activateApprovedRuntime,
  allowsExternalModelResources,
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

test('runtime definition needs only the core subtitle bundle and exposes refinement separately when installed', (t) => {
  const root = tempRoot(t)
  const userDataDir = path.join(root, 'user-data')
  const draftRoot = installArtifact(userDataDir, 'zipformer-bilingual-zh-en-2023-02-20')
  installArtifact(userDataDir, 'x-asr-160ms')
  installArtifact(userDataDir, 'silero-vad')

  const coreDefinition = createApprovedRuntimeDefinition({
    userDataDir,
    repoRoot: path.join(root, 'empty-repo'),
    env: {},
    Adapter: CapturingAdapter
  })
  assert.ok(coreDefinition)
  assert.equal(coreDefinition.runtimeOptions.refinementAvailable, false)
  assert.equal(coreDefinition.adapterFactory().options.refinement, null)

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
  assert.equal(adapter.options.draftRecognizer.modelDir, draftRoot)
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
  const draft = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'replacement-candidates', APPROVED_DRAFT_MODEL.directoryName)
  const realtime = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-160', APPROVED_REALTIME_MODEL.directoryName)
  const offline = path.join(repoRoot, 'models', 'gate-0b', 'extracted', 'x-asr-offline', APPROVED_REFINEMENT_MODEL.directoryName)
  const vad = path.join(repoRoot, 'models', 'vad')
  for (const [directory, artifactId] of [[draft, 'zipformer-bilingual-zh-en-2023-02-20'], [realtime, 'x-asr-160ms'], [offline, 'x-asr-offline']]) {
    fs.mkdirSync(directory, { recursive: true })
    for (const name of ARTIFACTS.get(artifactId).requiredFiles) fs.writeFileSync(path.join(directory, name), 'stub')
  }
  fs.mkdirSync(vad, { recursive: true })
  fs.writeFileSync(path.join(vad, 'silero_vad.onnx'), 'stub')

  for (const id of ['zipformer-bilingual-zh-en-2023-02-20', 'x-asr-160ms', 'x-asr-offline', 'silero-vad']) {
    assert.equal(isExternalArtifactReady(id, { repoRoot, env: {} }), true)
  }
  assert.equal(isExternalArtifactReady('unknown', { repoRoot, env: {} }), false)
})

test('external model resources require one explicit development flag', () => {
  assert.equal(allowsExternalModelResources({}), false)
  assert.equal(allowsExternalModelResources({ LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS: '' }), false)
  assert.equal(allowsExternalModelResources({ LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS: 'true' }), false)
  assert.equal(allowsExternalModelResources({ LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS: '1' }), true)
  assert.equal(allowsExternalModelResources(
    { LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS: '1' },
    { packaged: true }
  ), false)
})

test('runtime uses marker-audited userData unless external resources are explicitly allowed', (t) => {
  const root = tempRoot(t)
  const userDataDir = path.join(root, 'user-data')
  const installedDraft = installArtifact(userDataDir, 'zipformer-bilingual-zh-en-2023-02-20')
  const installedRealtime = installArtifact(userDataDir, 'x-asr-160ms')
  const installedRefinement = installArtifact(userDataDir, 'x-asr-offline')
  const installedVad = installArtifact(userDataDir, 'silero-vad')

  const externalDraft = path.join(root, 'external', 'draft')
  const externalRealtime = path.join(root, 'external', 'realtime')
  const externalRefinement = path.join(root, 'external', 'refinement')
  const externalVad = path.join(root, 'external', 'silero_vad.onnx')
  for (const [directory, artifactId] of [
    [externalDraft, 'zipformer-bilingual-zh-en-2023-02-20'],
    [externalRealtime, 'x-asr-160ms'],
    [externalRefinement, 'x-asr-offline']
  ]) {
    fs.mkdirSync(directory, { recursive: true })
    for (const name of ARTIFACTS.get(artifactId).requiredFiles) {
      fs.writeFileSync(path.join(directory, name), 'external-stub')
    }
  }
  fs.mkdirSync(path.dirname(externalVad), { recursive: true })
  fs.writeFileSync(externalVad, 'external-stub')
  const env = {
    [DRAFT_MODEL_DIR_ENV]: externalDraft,
    [MODEL_DIR_ENV]: externalRealtime,
    [REFINE_MODEL_DIR_ENV]: externalRefinement,
    [VAD_MODEL_ENV]: externalVad
  }

  const defaultDefinition = createApprovedRuntimeDefinition({
    userDataDir,
    env,
    repoRoot: path.join(root, 'external-repo'),
    Adapter: CapturingAdapter
  })
  const defaultAdapter = defaultDefinition.adapterFactory()
  assert.equal(defaultAdapter.options.draftRecognizer.modelDir, installedDraft)
  assert.equal(defaultAdapter.options.recognizer.modelDir, installedRealtime)
  assert.equal(defaultAdapter.options.refinement.modelDir, installedRefinement)
  assert.equal(defaultAdapter.options.vad.modelPath, path.join(installedVad, 'silero_vad.onnx'))

  const externalDefinition = createApprovedRuntimeDefinition({
    userDataDir,
    allowExternal: true,
    env,
    repoRoot: path.join(root, 'external-repo'),
    Adapter: CapturingAdapter
  })
  const externalAdapter = externalDefinition.adapterFactory()
  assert.equal(externalAdapter.options.draftRecognizer.modelDir, externalDraft)
  assert.equal(externalAdapter.options.recognizer.modelDir, externalRealtime)
  assert.equal(externalAdapter.options.refinement.modelDir, externalRefinement)
  assert.equal(externalAdapter.options.vad.modelPath, externalVad)
})

test('activation delegates an internal runtime definition to the idle coordinator', (t) => {
  const root = tempRoot(t)
  const userDataDir = path.join(root, 'user-data')
  for (const id of ['zipformer-bilingual-zh-en-2023-02-20', 'x-asr-160ms', 'x-asr-offline', 'silero-vad']) installArtifact(userDataDir, id)
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
