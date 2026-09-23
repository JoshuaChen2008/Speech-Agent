'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RecognitionSettings } = require('../../src/main/recognition/recognition-settings')
const { assertRecognitionBinding } = require('../../src/contracts/recognition')
const credential = { accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' }
function setup (t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const settings = new RecognitionSettings({ directory, ...options })
  t.after(() => settings.close())
  return { settings, directory }
}
function save (settings, extra = {}) { return settings.update({ expectedRevision: settings.getPublic().revision, strategy: 'cloud-primary', appKey: 'project-synthetic', modelLabel: 'project model description', cloudDisclosureAccepted: true, credential, ...extra }) }

test('SEM-F12/F25 J20 damaged settings or journal preserve files and require explicit recovery before local start', t => {
  for (const damaged of ['settings', 'journal']) {
    const { settings, directory } = setup(t)
    save(settings)
    const target = damaged === 'settings' ? path.join(directory, 'settings.json') : path.join(directory, 'credentials/journal.v1.json')
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{broken')
    const recovered = new RecognitionSettings({ directory })
    t.after(() => recovered.close())
    assert.equal(recovered.getPublic().loadError, 'NLS_SETTINGS_UNAVAILABLE')
    assert.throws(() => recovered.freeze(), { code: 'NLS_SETTINGS_UNAVAILABLE' })
    assert.equal(fs.readFileSync(target, 'utf8'), '{broken')
    save(recovered, { strategy: 'local-only', credential: undefined })
    assert.equal(recovered.getPublic().loadError, null)
    assertRecognitionBinding(recovered.freeze())
    assert.equal(recovered.freeze().modelLabel, '')
    if (damaged === 'journal') assert.equal(fs.readFileSync(target, 'utf8'), '{broken')
    else assert.equal(fs.readdirSync(directory).some(name => name.startsWith('settings.json.recovery-')), true)
    const restart = new RecognitionSettings({ directory }); assertRecognitionBinding(restart.freeze()); restart.close()
  }
})

test('SEM-F14 J20 persistent to session-only credential replacement removes old generation; rollback restores it', t => {
  const { CredentialVault } = require('../../src/main/security/credential-vault')
  const { directory } = setup(t)
  let encrypted = true
  const vault = new CredentialVault({ directory: path.join(directory, 'test-vault'), safeStorage: {
    isEncryptionAvailable: () => encrypted, encryptString: value => Buffer.from(value), decryptString: value => value.toString()
  } })
  t.after(() => vault.close())
  const slot = 'slot.' + 'a'.repeat(32)
  const previous = vault.set(slot, 'old')
  encrypted = false
  let transaction = vault.prepareSet(slot, 'new', { persistence: previous.scope, generation: previous.generation })
  assert.equal(fs.existsSync(vault.file(slot, previous.generation)), false)
  vault.rollbackSet(transaction)
  assert.equal(fs.existsSync(vault.file(slot, previous.generation)), true)
  transaction = vault.prepareSet(slot, 'new', { persistence: previous.scope, generation: previous.generation })
  vault.commitSet(transaction)
  assert.equal(fs.readdirSync(vault.directory).length, 0)
  assert.equal(vault.state(slot, 'session_only', null).present, true)
})

test('SEM-F25 J20 Token clock errors are distinct from credential errors', async t => {
  const { settings } = setup(t, { tokenRequest: async () => { throw Object.assign(new Error('private'), { code: 'InvalidTimeStamp.Expired' }) } })
  save(settings)
  await assert.rejects(settings.getToken(), { code: 'NLS_CLOCK_INVALID' })
})

test('SEM-F14/J20 failed credential deletion is explicit and restart finishes the committed cleanup', t => {
  for (const clear of [false, true]) {
    let encrypted = true
    const safeStorage = { isEncryptionAvailable: () => encrypted,
      encryptString: value => Buffer.from(value).map(byte => byte ^ 99),
      decryptString: value => Buffer.from(value).map(byte => byte ^ 99).toString() }
    const { settings, directory } = setup(t, { safeStorage })
    save(settings)
    const priorRevision = settings.state.revision
    settings.cached = { token: 'cached-token', expireTime: Number.MAX_SAFE_INTEGER }
    settings.vault.fs = { ...fs, rmSync: (target, options) => {
      if (String(target).includes('.quarantine.')) throw Object.assign(new Error('external permission failure'), { code: 'EACCES' })
      return fs.rmSync(target, options)
    } }
    encrypted = false
    assert.throws(() => save(settings, clear ? { credential: undefined, clearCredential: true } : {}), { code: 'NLS_CREDENTIAL_CLEANUP_REQUIRED' })
    assert.equal(settings.state.revision, priorRevision + 1)
    assert.equal(settings.cached, null)
    assert.equal(settings.getPublic().loadError, 'NLS_CREDENTIAL_CLEANUP_REQUIRED')
    assert.throws(() => settings.freeze(), { code: 'NLS_CREDENTIAL_CLEANUP_REQUIRED' })
    assert.throws(() => save(settings), { code: 'NLS_CREDENTIAL_CLEANUP_REQUIRED' })
    assert.equal(fs.readdirSync(path.join(directory, 'credentials')).some(name => name.includes('.quarantine.')), true)
    settings.close()
    const restarted = new RecognitionSettings({ directory, safeStorage })
    assert.equal(restarted.getPublic().loadError, null)
    assert.equal(restarted.getPublic().credential.present, false)
    assert.equal(fs.readdirSync(path.join(directory, 'credentials')).length, 0)
    restarted.close()
  }
})

test('SEM-F25 J20 settings freeze exact local/cloud bindings; secrets never appear in public settings or plaintext disk', t => {
  const { settings, directory } = setup(t)
  assertRecognitionBinding(settings.freeze())
  save(settings)
  const binding = settings.freeze()
  assertRecognitionBinding(binding)
  assert.match(binding.projectRef, /^[a-f0-9]{64}$/)
  assert.equal(settings.getPublic().credential.scope, 'session_only')
  for (const value of [JSON.stringify(settings.getPublic()), JSON.stringify(binding), fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')]) assert.equal(value.includes(credential.accessKeySecret), false)
  const restarted = new RecognitionSettings({ directory })
  assert.equal(restarted.getPublic().credential.present, false)
  assert.throws(() => restarted.freeze(), { code: 'NLS_CONFIGURATION_REQUIRED' })
  restarted.close()
})

test('SEM-F25 J20 persistent encrypted credentials survive restart and explicit clear', t => {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(v => v ^ 99), decryptString: b => Buffer.from(b).map(v => v ^ 99).toString() }
  const { settings, directory } = setup(t, { safeStorage })
  save(settings)
  settings.close()
  const restarted = new RecognitionSettings({ directory, safeStorage, tokenRequest: async c => { assert.deepEqual(c, credential); return { Token: { Id: 'test-token', ExpireTime: Math.floor(Date.now() / 1000) + 3600 } } } })
  t.after(() => restarted.close())
  assert.equal(restarted.getPublic().credential.scope, 'persistent')
  return restarted.getToken().then(token => {
    assert.equal(token, 'test-token')
    save(restarted, { credential: undefined, clearCredential: true })
    assert.equal(restarted.getPublic().credential.present, false)
    assert.equal(fs.readdirSync(path.join(directory, 'credentials')).length, 0)
  })
})

test('SEM-F25 J20 active session, revision conflict, disclosure and unknown fields fail closed', t => {
  let active = false
  const { settings } = setup(t, { isActive: () => active })
  assert.throws(() => save(settings, { cloudDisclosureAccepted: false }), { code: 'NLS_DISCLOSURE_REQUIRED' })
  assert.throws(() => save(settings, { unexpected: true }), { code: 'NLS_INVALID_SETTINGS' })
  save(settings)
  assert.throws(() => save(settings, { expectedRevision: 0 }), { code: 'NLS_SETTINGS_CONFLICT' })
  active = true
  assert.throws(() => save(settings), { code: 'NLS_SESSION_ACTIVE' })
})

test('SEM-F25 J20 Token uses ExpireTime with five minute refresh and singleflight', async t => {
  let calls = 0; let now = 0
  const { settings } = setup(t, { now: () => now, tokenRequest: async () => { calls++; return { Token: { Id: `token-${calls}`, ExpireTime: now / 1000 + 3600 } } } })
  save(settings)
  assert.deepEqual(await Promise.all([settings.getToken(), settings.getToken()]), ['token-1', 'token-1'])
  assert.equal(calls, 1)
  now = 3299000; assert.equal(await settings.getToken(), 'token-1')
  now = 3300000; assert.equal(await settings.getToken(), 'token-2')
})

test('SEM-F25 J20 stale credential generation cannot cache token; authentication errors are sanitized without retry', async t => {
  let resolve; let calls = 0
  const { settings } = setup(t, { tokenRequest: () => { calls++; return new Promise(r => { resolve = r }) } })
  save(settings)
  const pending = settings.getToken()
  save(settings)
  resolve({ Token: { Id: 'stale', ExpireTime: Math.floor(Date.now() / 1000) + 3600 } })
  await assert.rejects(pending, { code: 'NLS_CONFIGURATION_CHANGED' })
  settings.tokenRequest = async () => { calls++; throw Object.assign(new Error('secret-url-and-body'), { code: 'InvalidAccessKeyId' }) }
  await assert.rejects(settings.getToken(), e => e.code === 'NLS_AUTH_FAILED' && !e.message.includes('secret-url'))
  assert.equal(calls, 2)
})

test('SEM-F25 J20 transient network error retries once; cancelled requests do not return token', async t => {
  let calls = 0
  const { settings } = setup(t, { tokenRequest: async () => { calls++; throw Object.assign(new Error('raw'), { code: 'ECONNRESET' }) } })
  save(settings)
  await assert.rejects(settings.getToken(), { code: 'NLS_TOKEN_UNAVAILABLE' })
  assert.equal(calls, 2)
  await assert.rejects(settings.getToken({ signal: AbortSignal.abort() }), { code: 'NLS_CANCELLED' })
  assert.equal(calls, 2)
})
