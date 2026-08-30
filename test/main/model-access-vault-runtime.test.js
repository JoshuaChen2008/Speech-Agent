'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { RemoteModelCatalogPullController } = require('../../src/agent/model-access/remote-catalog-controller')
const { sanitizedEnvironment } = require('../../src/agent/model-access/environment')

function vault (t, encryptionAvailable = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-vault-'))
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  }
  const instance = new CredentialVault({ directory, safeStorage })
  t.after(() => { instance.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { instance, directory }
}

test('SEM-F14/SEM-F33/J25: persistent and session-only credentials remain main-owned and borrowed copies clear', async (t) => {
  const persistent = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = persistent.instance.set(slot, 'secret-value')
  assert.equal(state.scope, 'persistent')
  assert.equal(fs.readFileSync(path.join(persistent.directory, fs.readdirSync(persistent.directory)[0])).includes(Buffer.from('secret-value')), false)
  let borrowed
  await persistent.instance.borrow(slot, 'persistent', state.generation, async (copy) => { borrowed = copy; assert.equal(copy.toString(), 'secret-value') })
  assert.equal(borrowed.every((byte) => byte === 0), true)

  const session = vault(t, false)
  const sessionState = session.instance.set(slot, 'temporary')
  assert.equal(sessionState.scope, 'session_only')
  assert.deepEqual(fs.readdirSync(session.directory), [])
  assert.deepEqual(session.instance.state(slot, 'absent', null), { present: true, scope: 'session_only' })
  session.instance.close()
  assert.deepEqual(session.instance.state(slot, 'absent', null), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: runtime configures credentials without sending plaintext to storage and publishes changed', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const calls = []
  const internal = { revision: 0, profiles: [{
    profile_id: 'profile.one', profile_revision: 1, catalog_revision: 0, label: 'One',
    template_id: null, https_origin: 'https://example.test', base_path: '/v1', models: [],
    credential_slot_id: slot, credential_persistence: 'absent', credential_generation: null
  }], assignments: {} }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async (input) => { calls.push(input); return { revision: 1 } },
      modelAccessBind: async () => ({})
    },
    onChanged: (event) => calls.push(event)
  })
  const result = await runtime.configure({ type: 'setCredential', expectedRevision: 0, profileId: 'profile.one', credential: 'plain-secret' })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(calls).includes('plain-secret'), false)
  assert.equal(calls[0].credentialState.scope, 'persistent')
  assert.deepEqual(calls[1], { revision: 1 })
})

test('SEM-F33/J25: remote pull is transient, rejects redirect, and clears credential copies', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'catalog-secret')
  const internal = { revision: 4, profiles: [{
    profile_id: 'deepseek', template_id: 'deepseek-openai-template@1',
    https_origin: 'https://api.deepseek.com', base_path: '/', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation
  }] }
  let copy
  const controller = new RemoteModelCatalogPullController({
    runtime: { internal: async () => internal }, vault: instance,
    adapter: { listModels: async ({ credential }) => { copy = credential; return [{ modelId: 'deepseek-v4-flash', capabilitySuggestion: null }] } }
  })
  const result = await controller.pull({ profileId: 'deepseek', expectedRevision: 4 })
  assert.equal(result.status, 'success')
  assert.equal(result.suggestions[0].capabilitySuggestion.maxInputTokens, null)
  assert.equal(copy.every((byte) => byte === 0), true)
  const redirect = new RemoteModelCatalogPullController({
    runtime: { internal: async () => internal }, vault: instance,
    adapter: { listModels: async () => { const error = new Error(); error.code = 'REDIRECT_REJECTED'; throw error } }
  })
  assert.deepEqual(await redirect.pull({ profileId: 'deepseek', expectedRevision: 4 }), { status: 'redirect_rejected', suggestions: [] })
  let invalidated = null
  const auth = new RemoteModelCatalogPullController({
    runtime: { internal: async () => internal, invalidateCredential: async (profileId) => { invalidated = profileId } },
    vault: instance,
    adapter: { listModels: async () => { const error = new Error(); error.code = 'AUTH_REJECTED'; throw error } }
  })
  assert.equal((await auth.pull({ profileId: 'deepseek', expectedRevision: 4 })).status, 'credential_unavailable')
  assert.equal(invalidated, 'deepseek')
})

test('SEM-F33/J25: startup environment removes every legacy credential spelling', () => {
  assert.deepEqual(sanitizedEnvironment({ Path: 'ok', DEEPSEEK_API_KEY: 'one', deepseek_api_key: 'two', Other: 3 }), { Path: 'ok' })
})

test('SEM-F33/J25: credential quarantine rolls back before a failed SQLite command', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'rollback-secret')
  const token = instance.prepareClear(slot, 'persistent', state.generation)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
  instance.rollbackClear(token)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })
  await instance.borrow(slot, 'persistent', state.generation, async (copy) => assert.equal(copy.toString(), 'rollback-secret'))
})

test('SEM-F33/J25: persistent credential journal recovers set from the committed SQLite generation', async (t) => {
  const created = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const oldState = created.instance.set(slot, 'old-secret')
  const prepared = created.instance.prepareSet(slot, 'new-secret', {
    persistence: 'persistent',
    generation: oldState.generation
  })
  const journalText = fs.readFileSync(path.join(created.directory, 'journal.v1.json'), 'utf8')
  assert.equal(journalText.includes('old-secret'), false)
  assert.equal(journalText.includes('new-secret'), false)
  assert.equal(journalText.includes('https://'), false)

  const beforeCommitRestart = new CredentialVault({ directory: created.directory, safeStorage: created.instance.safeStorage })
  beforeCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: oldState.generation }])
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', oldState.generation), { present: true, scope: 'persistent' })
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', prepared.state.generation), { present: false, scope: 'absent' })

  const preparedAfterRestart = beforeCommitRestart.prepareSet(slot, 'committed-secret', {
    persistence: 'persistent',
    generation: oldState.generation
  })
  const afterCommitRestart = new CredentialVault({ directory: created.directory, safeStorage: created.instance.safeStorage })
  afterCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: preparedAfterRestart.state.generation }])
  assert.deepEqual(afterCommitRestart.state(slot, 'persistent', oldState.generation), { present: false, scope: 'absent' })
  await afterCommitRestart.borrow(slot, 'persistent', preparedAfterRestart.state.generation, async (copy) => assert.equal(copy.toString(), 'committed-secret'))
})

test('SEM-F33/J25: setCredential rolls back the prepared generation when SQLite rejects the command', async (t) => {
  const { instance, directory } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const oldState = instance.set(slot, 'old-secret')
  const internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: oldState.generation
  }] }
  let oldGenerationRemainedAuthoritative = false
  let journalWasPrepared = false
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => {
        oldGenerationRemainedAuthoritative = instance.state(slot, 'persistent', oldState.generation).present
        journalWasPrepared = fs.existsSync(path.join(directory, 'journal.v1.json'))
        throw new Error('injected storage failure')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({ type: 'setCredential', expectedRevision: 8, profileId: 'profile.one', credential: 'new-secret' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MODEL_CONFIG_INVALID')
  assert.equal(oldGenerationRemainedAuthoritative, true)
  assert.equal(journalWasPrepared, true)
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.bin')).length, 1)
  assert.equal(fs.existsSync(path.join(directory, 'journal.v1.json')), false)
  await instance.borrow(slot, 'persistent', oldState.generation, async (copy) => assert.equal(copy.toString(), 'old-secret'))
})

test('SEM-F33/J25: credential quarantine recovery follows the committed SQLite fact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-vault-recover-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  }
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const first = new CredentialVault({ directory: root, safeStorage })
  const state = first.set(slot, 'recover-secret')
  first.prepareClear(slot, 'persistent', state.generation)

  const beforeCommitRestart = new CredentialVault({ directory: root, safeStorage })
  beforeCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: state.generation }])
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })

  beforeCommitRestart.prepareClear(slot, 'persistent', state.generation)
  const afterCommitRestart = new CredentialVault({ directory: root, safeStorage })
  afterCommitRestart.recover([])
  assert.deepEqual(afterCommitRestart.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
  assert.deepEqual(fs.readdirSync(root), [])
  first.close()
  beforeCommitRestart.close()
  afterCommitRestart.close()
  fs.rmSync(root, { recursive: true, force: true })
})
