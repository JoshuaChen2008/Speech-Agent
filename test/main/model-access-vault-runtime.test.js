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
})

test('SEM-F33/J25: startup environment removes every legacy credential spelling', () => {
  assert.deepEqual(sanitizedEnvironment({ Path: 'ok', DEEPSEEK_API_KEY: 'one', deepseek_api_key: 'two', Other: 3 }), { Path: 'ok' })
})
