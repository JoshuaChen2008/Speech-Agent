'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { ModelAccessStore } = require('../../src/runtime/storage-worker/model-access-store')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

const capabilities = Object.freeze({
  maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true,
  supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true
})

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-access-store-'))
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'speech-agent.sqlite3'), migrations: FORMAL_AGENT_MIGRATIONS, now: () => 1000
  })
  t.after(() => {
    try { subtitleStore.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, store: new ModelAccessStore({ subtitleStore, now: () => 1000 }) }
}

function command (store, value) {
  return store.configure({ command: { ...value, expectedRevision: store.revision() } })
}

function addProfileModel (store, profileId = 'profile.one', modelId = 'model-one') {
  command(store, { type: 'createProfile', profileId, label: 'Profile One', httpsOrigin: 'https://example.test', basePath: '/v1' })
  command(store, { type: 'addModel', profileId, modelId, capabilities })
  const profile = store.internalCatalog().profiles.find((item) => item.profile_id === profileId)
  store.configure({
    command: { type: 'setCredential', expectedRevision: store.revision(), profileId, credential: 'synthetic' },
    credentialState: { scope: 'persistent', generation: 'generation.0000000000000001' }
  })
  return profile.credential_slot_id
}

function insertRun (database, runId = 'run.bind.one') {
  database.prepare(`INSERT INTO formal_agent_runs(
    run_id,dedupe_key,client_idempotency_key,request_digest,recipe_id,recipe_version,
    scope_json,scope_digest,transcript_version,input_watermark_json,input_digest,requested_by,
    state,attempt_count,max_attempts,next_attempt_at,created_at,updated_at
  ) VALUES(?,?,NULL,?,'context.ingest.session','1',?,?, 'raw',?,?, 'automatic',
    'queued',0,3,0,1000,1000)`).run(
    runId, sha256Canonical({ runId }), sha256Canonical({ request: runId }),
    canonicalize({ kind: 'session', reference: 'session-one' }), sha256Canonical({ scope: runId }),
    canonicalize({ throughEventOrder: 1 }), sha256Canonical({ input: runId })
  )
}

test('SEM-F33/J25: nine commands use one revision and failures are zero-write', (t) => {
  const { store } = fixture(t)
  const before = JSON.stringify(store.internalCatalog())
  assert.throws(() => store.configure({ command: {
    type: 'createProfile', expectedRevision: 99, profileId: 'stale', label: 'Stale',
    httpsOrigin: 'https://example.test', basePath: '/v1'
  } }), (error) => error.code === 'MODEL_CONFIG_REVISION_CONFLICT')
  assert.equal(JSON.stringify(store.internalCatalog()), before)
  addProfileModel(store)
  command(store, { type: 'assignPurpose', purpose: 'default', target: { profileId: 'profile.one', modelId: 'model-one' } })
  command(store, { type: 'assignPurpose', purpose: 'information_extraction', target: null })
  assert.equal(store.resolveAssignment('information_extraction').assignmentMode, 'fallback_default')
  const revision = store.revision()
  assert.equal(revision, 5)
  assert.equal(store.internalCatalog().assignments.summary.configuration_revision, revision)
})

test('SEM-F33/J25: bind validates an existing v5 run and replays one immutable snapshot', (t) => {
  const { subtitleStore, store } = fixture(t)
  const slot = addProfileModel(store)
  command(store, { type: 'assignPurpose', purpose: 'information_extraction', target: { profileId: 'profile.one', modelId: 'model-one' } })
  insertRun(subtitleStore.database)
  const request = { runId: 'run.bind.one', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'single_shot' }
  const first = store.bind(request, [slot])
  command(store, { type: 'updateModel', profileId: 'profile.one', modelId: 'model-one', capabilities: { ...capabilities, maxOutputTokens: 2048 } })
  assert.deepEqual(store.bind(request), first)
  assert.equal(first.capabilities.maxOutputTokens, 4096)
  assert.equal(Object.keys(first).some((key) => /price|cost|currency|pricing/i.test(key)), false)
  assert.throws(() => subtitleStore.database.prepare("UPDATE agent_model_run_bindings SET model_id='other' WHERE run_id='run.bind.one'").run(), /immutable/i)
})

test('SEM-F33/J25: deleting a profile preserves binding identity and never reseeds the template', (t) => {
  const { subtitleStore, store } = fixture(t)
  const slot = addProfileModel(store)
  command(store, { type: 'assignPurpose', purpose: 'information_extraction', target: { profileId: 'profile.one', modelId: 'model-one' } })
  insertRun(subtitleStore.database)
  const binding = store.bind({ runId: 'run.bind.one', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'single_shot' }, [slot])
  command(store, { type: 'deleteProfile', profileId: 'profile.one' })
  assert.equal(subtitleStore.database.prepare("SELECT model_id FROM agent_model_run_bindings WHERE run_id='run.bind.one'").get().model_id, binding.modelId)
  command(store, { type: 'deleteProfile', profileId: 'deepseek' })
  assert.equal(store.internalCatalog().profiles.some((profile) => profile.profile_id === 'deepseek'), false)
  const reopened = new ModelAccessStore({ subtitleStore, now: () => 1000 })
  assert.equal(reopened.internalCatalog().profiles.some((profile) => profile.profile_id === 'deepseek'), false)
})
