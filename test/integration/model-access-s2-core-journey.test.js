'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { RemoteModelCatalogPullController } = require('../../src/agent/model-access/remote-catalog-controller')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { ModelAccessStore } = require('../../src/runtime/storage-worker/model-access-store')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { fauxProvider } = require('./faux-provider')

const capabilities = { maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }

test('SEM-F00/SEM-F33/J25: S2 Core configures two profiles, resolves fallback, binds immutably and keeps remote suggestions transient', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-access-s2-'))
  const subtitleStore = new SqliteSubtitleStore({ databasePath: path.join(root, 'speech-agent.sqlite3'), migrations: FORMAL_AGENT_MIGRATIONS, now: () => 1000 })
  const store = new ModelAccessStore({ subtitleStore, now: () => 1000 })
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString()
  } })
  t.after(() => { vault.close(); subtitleStore.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const gateway = {
    modelAccessCatalog: async () => store.internalCatalog(),
    modelAccessConfigure: async (input) => store.configure(input),
    modelAccessBind: async (request, slots) => store.bind(request, slots)
  }
  const changes = []
  const runtime = new ModelAccessRuntime({ gateway, vault, onChanged: ({ revision }) => changes.push(revision) })
  let snapshot = (await runtime.catalog()).snapshot
  assert.equal(snapshot.profiles[0].models.length, 0)
  assert.equal(snapshot.readinessByPurpose.default.singleShot, 'provider_not_configured')

  const configure = async (command) => {
    const result = await runtime.configure({ ...command, expectedRevision: (await runtime.catalog()).snapshot.revision })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  await configure({ type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities })
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
  await configure({ type: 'createProfile', profileId: 'local.profile', label: 'Local Profile', httpsOrigin: 'https://localhost:8443', basePath: '/v1' })
  await configure({ type: 'addModel', profileId: 'local.profile', modelId: 'local-model', capabilities: { ...capabilities, supportsToolCalling: false } })
  snapshot = (await runtime.catalog()).snapshot
  assert.equal(snapshot.readinessByPurpose.summary.assignmentMode, 'fallback_default')
  assert.equal(snapshot.readinessByPurpose.default.singleShot, 'ready')
  assert.deepEqual(changes, [1, 2, 3, 4, 5])

  const runId = 'run.s2.binding'
  subtitleStore.database.prepare(`INSERT INTO formal_agent_runs(
    run_id,dedupe_key,request_digest,recipe_id,recipe_version,scope_json,scope_digest,
    transcript_version,input_watermark_json,input_digest,requested_by,state,attempt_count,
    max_attempts,next_attempt_at,created_at,updated_at
  ) VALUES(?,?,?,'context.ingest.session','1',?,?, 'raw',?,?, 'automatic','queued',0,3,0,1000,1000)`)
    .run(runId, sha256Canonical({ runId }), sha256Canonical({ request: runId }), canonicalize({ kind: 'session' }), sha256Canonical({ scope: runId }), canonicalize({ throughEventOrder: 1 }), sha256Canonical({ input: runId }))
  const binding = await runtime.bind({ runId, recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'single_shot' })
  await configure({ type: 'updateModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities: { ...capabilities, maxOutputTokens: 2048 } })
  assert.deepEqual(await runtime.bind({ runId, recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'single_shot' }), binding)

  const pull = new RemoteModelCatalogPullController({ runtime, vault, adapter: fauxProvider() })
  const beforePull = (await runtime.catalog()).snapshot.revision
  const suggestions = await pull.pull({ profileId: 'deepseek', expectedRevision: beforePull })
  assert.equal(suggestions.status, 'success')
  assert.equal((await runtime.catalog()).snapshot.revision, beforePull)
  assert.equal(store.internalCatalog().profiles.find((p) => p.profile_id === 'deepseek').models.length, 1)

  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='formal_agent_interactions'").get().count, 0)
  assert.equal(JSON.stringify(snapshot).includes('credentialSlotId'), false)
  assert.equal(/price|cost|currency|pricing/i.test(JSON.stringify(binding)), false)
})
