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

function insertRun (database, runId = 'run.bind.one', recipeId = 'context.ingest.session', requestedBy = 'automatic', recipeVersion = '1') {
  const clientIdempotencyKey = requestedBy === 'user' ? `client.${runId}` : null
  database.prepare(`INSERT INTO formal_agent_runs(
    run_id,dedupe_key,client_idempotency_key,request_digest,recipe_id,recipe_version,
    scope_json,scope_digest,transcript_version,input_watermark_json,input_digest,requested_by,
    state,attempt_count,max_attempts,next_attempt_at,created_at,updated_at
  ) VALUES(?,?,?, ?,?,?,?, ?, 'raw',?,?, ?,
    'queued',0,3,0,1000,1000)`).run(
    runId, sha256Canonical({ runId }), clientIdempotencyKey, sha256Canonical({ request: runId }), recipeId, recipeVersion,
    canonicalize({ kind: 'session', reference: 'session-one' }), sha256Canonical({ scope: runId }),
    canonicalize({ throughEventOrder: 1 }), sha256Canonical({ input: runId }), requestedBy
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

test('SEM-F33/J25: every configure command advances once and its business rejection is zero-write', (t) => {
  const { store } = fixture(t)
  const apply = (command, extra = {}) => {
    const before = store.revision()
    const result = store.configure({ command: { ...command, expectedRevision: before }, ...extra })
    assert.equal(result.revision, before + 1, command.type)
  }
  const rejectWithoutWrite = (command, extra = {}) => {
    const before = JSON.stringify(store.internalCatalog())
    assert.throws(() => store.configure({ command: { ...command, expectedRevision: store.revision() }, ...extra }),
      (error) => error.code === 'MODEL_CONFIG_INVALID')
    assert.equal(JSON.stringify(store.internalCatalog()), before, command.type)
  }

  apply({ type: 'createProfile', profileId: 'profile.matrix', label: 'Matrix', httpsOrigin: 'https://matrix.test', basePath: '/v1' })
  rejectWithoutWrite({ type: 'createProfile', profileId: 'profile.matrix', label: 'Duplicate', httpsOrigin: 'https://matrix.test', basePath: '/v1' })
  apply({ type: 'updateProfile', profileId: 'profile.matrix', label: 'Matrix Updated', httpsOrigin: 'https://matrix.test', basePath: '/api' })
  rejectWithoutWrite({ type: 'updateProfile', profileId: 'missing', label: 'Missing', httpsOrigin: 'https://matrix.test', basePath: '/v1' })
  apply({ type: 'addModel', profileId: 'profile.matrix', modelId: 'model.one', capabilities })
  rejectWithoutWrite({ type: 'addModel', profileId: 'profile.matrix', modelId: 'model.one', capabilities })
  apply({ type: 'updateModel', profileId: 'profile.matrix', modelId: 'model.one', capabilities: { ...capabilities, maxOutputTokens: 2048 } })
  rejectWithoutWrite({ type: 'updateModel', profileId: 'profile.matrix', modelId: 'missing', capabilities })
  apply({ type: 'setCredential', profileId: 'profile.matrix' }, {
    credentialState: { scope: 'persistent', generation: 'generation.00000000000000000000000000000001' }
  })
  rejectWithoutWrite({ type: 'setCredential', profileId: 'missing' }, {
    credentialState: { scope: 'persistent', generation: 'generation.00000000000000000000000000000002' }
  })
  apply({ type: 'assignPurpose', purpose: 'summary', target: { profileId: 'profile.matrix', modelId: 'model.one' } })
  rejectWithoutWrite({ type: 'assignPurpose', purpose: 'summary', target: { profileId: 'profile.matrix', modelId: 'missing' } })
  apply({ type: 'removeModel', profileId: 'profile.matrix', modelId: 'model.one' })
  rejectWithoutWrite({ type: 'removeModel', profileId: 'profile.matrix', modelId: 'model.one' })
  apply({ type: 'clearCredential', profileId: 'profile.matrix' })
  rejectWithoutWrite({ type: 'clearCredential', profileId: 'missing' })
  apply({ type: 'deleteProfile', profileId: 'profile.matrix' })
  rejectWithoutWrite({ type: 'deleteProfile', profileId: 'profile.matrix' })
})

test('SEM-F33/J25: bind validates an existing v5 run and replays one immutable snapshot', (t) => {
  const { subtitleStore, store } = fixture(t)
  const slot = addProfileModel(store)
  command(store, { type: 'assignPurpose', purpose: 'information_extraction', target: { profileId: 'profile.one', modelId: 'model-one' } })
  insertRun(subtitleStore.database)
  const request = { runId: 'run.bind.one', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' }
  const first = store.bind(request, [slot])
  command(store, { type: 'updateModel', profileId: 'profile.one', modelId: 'model-one', capabilities: { ...capabilities, maxOutputTokens: 2048 } })
  assert.deepEqual(store.bind(request), first)
  assert.equal(first.capabilities.maxOutputTokens, 4096)
  assert.equal(Object.keys(first).some((key) => /price|cost|currency|pricing/i.test(key)), false)
  assert.throws(() => subtitleStore.database.prepare("UPDATE agent_model_run_bindings SET model_id='other' WHERE run_id='run.bind.one'").run(), /immutable/i)
  subtitleStore.database.prepare("DELETE FROM formal_agent_runs WHERE run_id='run.bind.one'").run()
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM agent_model_run_bindings WHERE run_id='run.bind.one'").get().count, 0)
})

test('SEM-F39/J31-COMPAT: SQLite bind derives the summary budget from recipe version', (t) => {
  const { subtitleStore, store } = fixture(t)
  const roomyCapabilities = {
    maxInputTokens: 200000, maxOutputTokens: 1100000, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true
  }
  command(store, { type: 'createProfile', profileId: 'summary.profile', label: 'Summary', httpsOrigin: 'https://summary.test', basePath: '/v1' })
  command(store, { type: 'addModel', profileId: 'summary.profile', modelId: 'summary-model', capabilities: roomyCapabilities })
  const profile = store.internalCatalog().profiles.find((item) => item.profile_id === 'summary.profile')
  store.configure({
    command: { type: 'setCredential', expectedRevision: store.revision(), profileId: 'summary.profile', credential: 'synthetic' },
    credentialState: { scope: 'persistent', generation: 'generation.0000000000000001' }
  })
  command(store, { type: 'assignPurpose', purpose: 'summary', target: { profileId: 'summary.profile', modelId: 'summary-model' } })
  insertRun(subtitleStore.database, 'run.summary.v1', 'summary.minutes', 'user', '1')
  insertRun(subtitleStore.database, 'run.summary.v2', 'summary.minutes', 'user', '2')

  const v1Request = { runId: 'run.summary.v1', recipeId: 'summary.minutes', recipeVersion: '1', executionForm: 'agent_loop' }
  const v2Request = { runId: 'run.summary.v2', recipeId: 'summary.minutes', recipeVersion: '2', executionForm: 'agent_loop' }
  const v1 = store.bind(v1Request, [profile.credential_slot_id])
  const v2 = store.bind(v2Request, [profile.credential_slot_id])
  assert.equal(v1.budget.maxCumulativeInputTokens, 120000)
  assert.equal(v1.budget.maxCumulativeOutputTokens, 8000)
  assert.equal(v2.budget.maxCumulativeInputTokens, 16000000)
  assert.equal(v2.budget.maxCumulativeOutputTokens, 1000000)
  assert.deepEqual(Object.keys(v1Request).sort(), ['executionForm', 'recipeId', 'recipeVersion', 'runId'])
  assert.throws(() => store.bind({ ...v2Request, budget: v2.budget }, [profile.credential_slot_id]), /exactly|runRequest/i)
  assert.deepEqual(store.bind(v2Request), v2)
})

test('SEM-F36/J25: preset strategy identity is persisted for matching preset profiles and custom tuples stay compatible', (t) => {
  const { subtitleStore, store } = fixture(t)
  command(store, { type: 'createProfile', profileId: 'preset.deepseek-openai', label: 'DeepSeek', httpsOrigin: 'https://api.deepseek.com', basePath: '/' })
  command(store, { type: 'addModel', profileId: 'preset.deepseek-openai', modelId: 'deepseek-v4-flash', capabilities })
  command(store, { type: 'createProfile', profileId: 'custom.deepseek', label: 'Custom', httpsOrigin: 'https://api.deepseek.com', basePath: '/' })
  command(store, { type: 'addModel', profileId: 'custom.deepseek', modelId: 'deepseek-v4-flash', capabilities })
  command(store, { type: 'createProfile', profileId: 'deepseek-openai', label: 'Custom id', httpsOrigin: 'https://api.deepseek.com', basePath: '/' })
  command(store, { type: 'addModel', profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', capabilities })
  const catalog = store.internalCatalog()
  const presetModel = catalog.profiles.find((profile) => profile.profile_id === 'preset.deepseek-openai').models[0]
  const customModel = catalog.profiles.find((profile) => profile.profile_id === 'custom.deepseek').models[0]
  const collidingCustomModel = catalog.profiles.find((profile) => profile.profile_id === 'deepseek-openai').models[0]
  assert.equal(presetModel.preset_identity, 'deepseek-openai@1')
  assert.equal(presetModel.request_strategy, 'deepseek-openai@1')
  assert.equal(customModel.preset_identity, null)
  assert.equal(customModel.request_strategy, 'openai-compatible@1')
  assert.equal(collidingCustomModel.preset_identity, null)
  assert.equal(collidingCustomModel.request_strategy, 'openai-compatible@1')
  command(store, { type: 'updateProfile', profileId: 'preset.deepseek-openai', label: 'DeepSeek', httpsOrigin: 'https://other.example', basePath: '/v1' })
  const changed = store.internalCatalog().profiles.find((profile) => profile.profile_id === 'preset.deepseek-openai').models[0]
  assert.equal(changed.preset_identity, null)
  assert.equal(changed.request_strategy, 'openai-compatible@1')
  command(store, { type: 'createProfile', profileId: 'preset.openai-gpt-4.1-mini', label: 'OpenAI', httpsOrigin: 'https://api.openai.com', basePath: '/v1' })
  command(store, { type: 'addModel', profileId: 'preset.openai-gpt-4.1-mini', modelId: 'gpt-4.1-mini-2025-04-14', capabilities })
  const openaiModel = store.internalCatalog().profiles.find((profile) => profile.profile_id === 'preset.openai-gpt-4.1-mini').models[0]
  assert.equal(openaiModel.preset_identity, 'openai-gpt-4.1-mini@1')
  assert.equal(openaiModel.request_strategy, 'openai-compatible@1')
  command(store, { type: 'createProfile', profileId: 'preset.qwen-beijing', label: '通义千问', httpsOrigin: 'https://dashscope.aliyuncs.com', basePath: '/compatible-mode/v1' })
  command(store, { type: 'addModel', profileId: 'preset.qwen-beijing', modelId: 'qwen-plus', capabilities })
  const qwenSlot = store.internalCatalog().profiles.find((profile) => profile.profile_id === 'preset.qwen-beijing').credential_slot_id
  store.configure({ command: { type: 'setCredential', expectedRevision: store.revision(), profileId: 'preset.qwen-beijing' }, credentialState: { scope: 'persistent', generation: 'generation.0000000000000001' } })
  command(store, { type: 'assignPurpose', purpose: 'default', target: { profileId: 'preset.qwen-beijing', modelId: 'qwen-plus' } })
  insertRun(subtitleStore.database, 'run.qwen.strategy')
  const binding = store.bind({ runId: 'run.qwen.strategy', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' }, [qwenSlot])
  assert.equal(binding.requestStrategy, 'qwen-beijing@1')
  assert.equal(subtitleStore.database.prepare("SELECT request_strategy FROM agent_model_run_bindings WHERE run_id='run.qwen.strategy'").get().request_strategy, 'qwen-beijing@1')
})

test('SEM-F36/J25: reserved preset profile ids reject non-preset connection tuples', (t) => {
  const { store } = fixture(t)
  assert.throws(() => command(store, {
    type: 'createProfile', profileId: 'preset.qwen-beijing', label: 'Custom',
    httpsOrigin: 'https://example.test', basePath: '/v1'
  }), (error) => error.code === 'MODEL_CONFIG_INVALID')
})

test('SEM-F36/J25: unknown preset profile ids remain reserved in the storage boundary', (t) => {
  const { store } = fixture(t)
  assert.throws(() => command(store, {
    type: 'createProfile', profileId: 'preset.future-provider', label: 'Future',
    httpsOrigin: 'https://example.test', basePath: '/v1'
  }), (error) => error.code === 'MODEL_CONFIG_INVALID')
})

test('SEM-F33/J25: deleting a profile preserves binding identity and never reseeds the template', (t) => {
  const { subtitleStore, store } = fixture(t)
  const slot = addProfileModel(store)
  command(store, { type: 'assignPurpose', purpose: 'information_extraction', target: { profileId: 'profile.one', modelId: 'model-one' } })
  insertRun(subtitleStore.database)
  const binding = store.bind({ runId: 'run.bind.one', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' }, [slot])
  command(store, { type: 'deleteProfile', profileId: 'profile.one' })
  assert.equal(subtitleStore.database.prepare("SELECT model_id FROM agent_model_run_bindings WHERE run_id='run.bind.one'").get().model_id, binding.modelId)
  command(store, { type: 'deleteProfile', profileId: 'deepseek' })
  assert.equal(store.internalCatalog().profiles.some((profile) => profile.profile_id === 'deepseek'), false)
  const reopened = new ModelAccessStore({ subtitleStore, now: () => 1000 })
  assert.equal(reopened.internalCatalog().profiles.some((profile) => profile.profile_id === 'deepseek'), false)
})

test('SEM-F16/SEM-F33/J22: zero-tool recipe binds to a model without tool calling', (t) => {
  const { subtitleStore, store } = fixture(t)
  const noTools = { ...capabilities, supportsToolCalling: false }
  command(store, { type: 'createProfile', profileId: 'text.profile', label: 'Text Profile', httpsOrigin: 'https://text.test', basePath: '/v1' })
  command(store, { type: 'addModel', profileId: 'text.profile', modelId: 'text-model', capabilities: noTools })
  const profile = store.internalCatalog().profiles.find((item) => item.profile_id === 'text.profile')
  store.configure({
    command: { type: 'setCredential', expectedRevision: store.revision(), profileId: 'text.profile', credential: 'synthetic' },
    credentialState: { scope: 'persistent', generation: 'generation.0000000000000001' }
  })
  command(store, { type: 'assignPurpose', purpose: 'default', target: { profileId: 'text.profile', modelId: 'text-model' } })
  insertRun(subtitleStore.database, 'run.text.no-tools', 'text.rewrite', 'user')
  const binding = store.bind({ runId: 'run.text.no-tools', recipeId: 'text.rewrite', recipeVersion: '1', executionForm: 'agent_loop' }, [profile.credential_slot_id])
  assert.equal(binding.executionForm, 'agent_loop')
  assert.equal(binding.budget.maxTurns, 1)
})
