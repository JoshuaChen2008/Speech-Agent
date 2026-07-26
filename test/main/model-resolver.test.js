'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
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
} = require('../../src/main/services/model-resolver')

function makeTempRoot (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-resolver-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeModelFiles (directory, files = REQUIRED_FILES) {
  fs.mkdirSync(directory, { recursive: true })
  for (const name of files) fs.writeFileSync(path.join(directory, name), 'stub')
}

test('resolver returns null when no candidate has the full file set', (t) => {
  const root = makeTempRoot(t)
  const incomplete = path.join(root, 'incomplete')
  writeModelFiles(incomplete, REQUIRED_FILES.slice(0, 2))
  assert.equal(resolveApprovedRealtimeModel({
    env: { [MODEL_DIR_ENV]: incomplete },
    userDataDir: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo')
  }), null)
})

test('explicit environment directory wins and carries the approved decision constants', (t) => {
  const root = makeTempRoot(t)
  const explicit = path.join(root, 'explicit-model')
  writeModelFiles(explicit)
  const repoModel = path.join(root, 'repo', 'models', 'gate-0b', 'extracted', 'x-asr-160', APPROVED_REALTIME_MODEL.directoryName)
  writeModelFiles(repoModel)

  const resolved = resolveApprovedRealtimeModel({
    env: { [MODEL_DIR_ENV]: explicit },
    userDataDir: null,
    repoRoot: path.join(root, 'repo')
  })
  assert.equal(resolved.modelDir, explicit)
  assert.equal(resolved.id, 'x-asr-160ms')
  assert.equal(resolved.profile, 'fast')
  assert.equal(resolved.numThreads, 4)
  assert.equal(resolved.kind, 'sherpa-online-transducer')
  assert.ok(Object.isFrozen(resolved))
})

test('an invalid explicit directory falls through to the next candidates', (t) => {
  const root = makeTempRoot(t)
  const userData = path.join(root, 'user-data')
  const installed = path.join(userData, 'models', APPROVED_REALTIME_MODEL.id, APPROVED_REALTIME_MODEL.directoryName)
  writeModelFiles(installed)

  const resolved = resolveApprovedRealtimeModel({
    env: { [MODEL_DIR_ENV]: path.join(root, 'missing') },
    userDataDir: userData,
    repoRoot: path.join(root, 'repo')
  })
  assert.equal(resolved.modelDir, installed)
})

test('refinement resolver requires the offline four-file set and carries decision constants', (t) => {
  const root = makeTempRoot(t)
  const incomplete = path.join(root, 'incomplete')
  writeModelFiles(incomplete, REFINEMENT_REQUIRED_FILES.slice(0, 2))
  assert.equal(resolveApprovedRefinementModel({
    env: { [REFINE_MODEL_DIR_ENV]: incomplete },
    userDataDir: null,
    repoRoot: path.join(root, 'repo')
  }), null)

  const repoModel = path.join(root, 'repo', 'models', 'gate-0b', 'extracted', 'x-asr-offline', APPROVED_REFINEMENT_MODEL.directoryName)
  writeModelFiles(repoModel, REFINEMENT_REQUIRED_FILES)
  const resolved = resolveApprovedRefinementModel({ env: {}, userDataDir: null, repoRoot: path.join(root, 'repo') })
  assert.equal(resolved.modelDir, repoModel)
  assert.equal(resolved.id, 'x-asr-offline')
  assert.equal(resolved.kind, 'sherpa-offline-transducer')
  assert.equal(resolved.numThreads, 3)
  assert.ok(Object.isFrozen(resolved))

  const installed = path.join(root, 'user-data', 'models', APPROVED_REFINEMENT_MODEL.id, APPROVED_REFINEMENT_MODEL.directoryName)
  writeModelFiles(installed, REFINEMENT_REQUIRED_FILES)
  assert.equal(
    resolveApprovedRefinementModel({ env: {}, userDataDir: path.join(root, 'user-data'), repoRoot: path.join(root, 'repo') }).modelDir,
    installed
  )
})

test('silero VAD resolver walks env, userData, then repo layout and fails closed', (t) => {
  const root = makeTempRoot(t)
  assert.equal(resolveSileroVadModel({
    env: {},
    userDataDir: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo')
  }), null)

  const repoModel = path.join(root, 'repo', 'models', 'vad', 'silero_vad.onnx')
  fs.mkdirSync(path.dirname(repoModel), { recursive: true })
  fs.writeFileSync(repoModel, 'stub')
  const fromRepo = resolveSileroVadModel({ env: {}, userDataDir: null, repoRoot: path.join(root, 'repo') })
  assert.equal(fromRepo.kind, 'silero')
  assert.equal(fromRepo.modelPath, repoModel)
  assert.ok(Object.isFrozen(fromRepo))

  const installed = path.join(root, 'user-data', 'models', 'silero-vad', 'silero_vad.onnx')
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.writeFileSync(installed, 'stub')
  assert.equal(
    resolveSileroVadModel({ env: {}, userDataDir: path.join(root, 'user-data'), repoRoot: path.join(root, 'repo') }).modelPath,
    installed
  )

  const explicit = path.join(root, 'explicit.onnx')
  fs.writeFileSync(explicit, 'stub')
  assert.equal(
    resolveSileroVadModel({ env: { [VAD_MODEL_ENV]: explicit }, userDataDir: path.join(root, 'user-data'), repoRoot: path.join(root, 'repo') }).modelPath,
    explicit
  )
})

test('userData flat layout and repo development layout are both accepted, in that order', (t) => {
  const root = makeTempRoot(t)
  const userData = path.join(root, 'user-data')
  const flat = path.join(userData, 'models', APPROVED_REALTIME_MODEL.id)
  writeModelFiles(flat)
  const repoModel = path.join(root, 'repo', 'models', 'gate-0b', 'extracted', 'x-asr-160', APPROVED_REALTIME_MODEL.directoryName)
  writeModelFiles(repoModel)

  const resolved = resolveApprovedRealtimeModel({ env: {}, userDataDir: userData, repoRoot: path.join(root, 'repo') })
  assert.equal(resolved.modelDir, flat)

  fs.rmSync(flat, { recursive: true, force: true })
  const fallback = resolveApprovedRealtimeModel({ env: {}, userDataDir: userData, repoRoot: path.join(root, 'repo') })
  assert.equal(fallback.modelDir, repoModel)
})
