'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')

function makeVault (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-runtime-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  }
  const instance = new CredentialVault({ directory, safeStorage })
  t.after(() => { instance.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return instance
}

function profile (slot, generation, modelId = 'deepseek-v4-flash', profileId = 'deepseek-openai') {
  return {
    profile_id: profileId, profile_revision: 1, catalog_revision: 0, label: 'DeepSeek',
    https_origin: 'https://api.deepseek.com', base_path: '/', template_id: null,
    credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: generation,
    models: [{ modelId, request_strategy: 'deepseek-openai@1', capabilities: { maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true } }]
  }
}

test('SEM-F14/SEM-F36/J25: saved model test uses the frozen strategy and never writes configuration', async (t) => {
  const vault = makeVault(t)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = vault.set(slot, 'test-secret')
  const internal = { revision: 4, profiles: [profile(slot, state.generation)] }
  const calls = []
  const runtime = new ModelAccessRuntime({
    vault,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => { throw new Error('must not configure') },
      modelAccessBind: async () => { throw new Error('must not bind') }
    },
    adapter: { run: async (request) => { calls.push(request); return { text: '{"ok":true}', usage: null } } }
  })
  const result = await runtime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 4, testId: 'test.success' })
  assert.deepEqual(result, { ok: true, status: 'success', nextAction: 'none' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].testMode, true)
  assert.equal(calls[0].requestStrategy, 'deepseek-openai@1')
  assert.equal(Object.hasOwn(calls[0].resolvedModel, 'requestStrategy'), false)
  assert.equal(calls[0].resolvedModel.capabilities.maxOutputTokens, 256)
})

test('SEM-F36/J25: cancellation wins a pending test and clears its controller', async (t) => {
  const vault = makeVault(t)
  const slot = 'slot.abcdef0123456789abcdef0123456789'
  const state = vault.set(slot, 'cancel-secret')
  const internal = { revision: 1, profiles: [profile(slot, state.generation)] }
  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  const runtime = new ModelAccessRuntime({
    vault,
    gateway: { modelAccessCatalog: async () => internal },
    adapter: { run: async ({ signal }) => { entered(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); const error = new Error(); error.code = 'AGENT_CANCELLED'; throw error } }
  })
  const pending = runtime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 1, testId: 'test.cancel' })
  await enteredPromise
  assert.deepEqual(await runtime.cancelSavedModel('test.cancel'), { ok: false, status: 'cancelled', nextAction: 'none' })
  assert.deepEqual(await pending, { ok: false, status: 'cancelled', nextAction: 'none' })
  assert.deepEqual(await runtime.cancelSavedModel('test.cancel'), { ok: false, status: 'cancelled', nextAction: 'none' })
})

test('SEM-F36/J25: revision change after provider response discards stale success', async (t) => {
  const vault = makeVault(t)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = vault.set(slot, 'revision-secret')
  let reads = 0
  const first = { revision: 2, profiles: [profile(slot, state.generation)] }
  const second = { revision: 3, profiles: [profile(slot, state.generation)] }
  const runtime = new ModelAccessRuntime({
    vault,
    gateway: { modelAccessCatalog: async () => (++reads === 1 ? first : second) },
    adapter: { run: async () => ({ text: '{"ok":true}', usage: null }) }
  })
  assert.deepEqual(await runtime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 2, testId: 'test.stale' }), { ok: false, status: 'revision_conflict', nextAction: 'reload' })
})

test('SEM-F36/J25: cancellation registered before the first read and wins the second revision read', async (t) => {
  const vault = makeVault(t)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = vault.set(slot, 'race-secret')
  const internal = { revision: 1, profiles: [profile(slot, state.generation)] }
  let releaseFirst
  const firstRead = new Promise((resolve) => { releaseFirst = resolve })
  let reads = 0
  let calls = 0
  const runtime = new ModelAccessRuntime({
    vault,
    gateway: { modelAccessCatalog: async () => { reads += 1; if (reads === 1) await firstRead; return internal } },
    adapter: { run: async () => { calls += 1; return { text: '{"ok":true}', usage: null } } }
  })
  const early = runtime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 1, testId: 'test.early-cancel' })
  assert.deepEqual(await runtime.cancelSavedModel('test.early-cancel'), { ok: false, status: 'cancelled', nextAction: 'none' })
  releaseFirst()
  assert.deepEqual(await early, { ok: false, status: 'cancelled', nextAction: 'none' })
  assert.equal(calls, 0)

  reads = 0
  let releaseSecond
  const secondRead = new Promise((resolve) => { releaseSecond = resolve })
  const changed = { revision: 2, profiles: [profile(slot, state.generation)] }
  const raceRuntime = new ModelAccessRuntime({
    vault,
    gateway: { modelAccessCatalog: async () => { reads += 1; if (reads === 2) await secondRead; return reads === 1 ? internal : changed } },
    adapter: { run: async () => ({ text: '{"ok":true}', usage: null }) }
  })
  const late = raceRuntime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 1, testId: 'test.second-cancel' })
  while (reads < 2) await new Promise((resolve) => setImmediate(resolve))
  await raceRuntime.cancelSavedModel('test.second-cancel')
  releaseSecond()
  assert.deepEqual(await late, { ok: false, status: 'cancelled', nextAction: 'none' })
})

test('SEM-F36/J25: cancellation wins a rejected catalog read', async (t) => {
  const vault = makeVault(t)
  let rejectRead
  const read = new Promise((_, reject) => { rejectRead = reject })
  const runtime = new ModelAccessRuntime({
    vault,
    gateway: { modelAccessCatalog: async () => read },
    adapter: { run: async () => { throw new Error('must not call provider') } }
  })
  const pending = runtime.testSavedModel({ profileId: 'deepseek-openai', modelId: 'deepseek-v4-flash', expectedRevision: 1, testId: 'test.rejected-read' })
  assert.deepEqual(await runtime.cancelSavedModel('test.rejected-read'), { ok: false, status: 'cancelled', nextAction: 'none' })
  rejectRead(new Error('catalog unavailable'))
  assert.deepEqual(await pending, { ok: false, status: 'cancelled', nextAction: 'none' })
})
