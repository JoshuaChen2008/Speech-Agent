'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentStorageService, OPERATIONS: STORAGE } = require('../../src/agent-mvp/storage-service')
const { AgentExecutionService, OPERATIONS: AGENT } = require('../../src/agent-mvp/agent-service')
const { CredentialVault } = require('../../src/agent-mvp/credential-vault')
const { AgentMvpSettingsStore } = require('../../src/agent-mvp/settings-store')
const { AgentMvpRuntimeHost } = require('../../src/agent-mvp/runtime-host')

function request (operation, payload, requestId = operation) { return { version: 1, type: 'agent-mvp:request', requestId, operation, payload } }

test('SEM-F29 / J23 Agent storage service writes a synthetic terminal session through the real subtitle store', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-service-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new AgentStorageService()
  assert.equal(service.handle(request(STORAGE.INITIALIZE, { databasePath: path.join(root, 'agent.db') })).ok, true)
  const fixture = service.handle(request(STORAGE.CREATE_FIXTURE, { sourceId: 'loopback' }))
  assert.equal(fixture.ok, true)
  assert.equal(fixture.result.items.length, 2)
  const sessions = service.handle(request(STORAGE.LIST_SESSIONS, {}))
  assert.equal(sessions.result[0].state, 'closed')
  assert.equal(service.handle(request(STORAGE.CREATE_FIXTURE, { sourceId: 'both' })).error.code, 'AGENT_REQUEST_INVALID')
  service.handle(request(STORAGE.SHUTDOWN, {}))
})

test('SEM-F29 / J23 Agent execution service exposes only projected events and fixed reference output', async () => {
  const events = []
  const service = new AgentExecutionService({ emit: (event) => events.push(event) })
  const input = {
    inputRef: { sessionId: 'fixture-session', inputWatermark: 1, transcriptVersion: 'original', inputDigest: 'a'.repeat(64) },
    items: [{ segmentId: 'segment-1', sourceId: 'loopback', text: 'synthetic fixture text' }]
  }
  const provider = { provider: 'deterministic-test', configuration: { provider: 'deterministic-test', baseUrl: '', model: 'fixture-model' }, apiKey: null }
  const result = await service.handle(request(AGENT.RUN_REFERENCE, { runId: 'run-1', input, provider }))
  assert.equal(result.ok, true)
  assert.equal(result.result.content.title, '隔离参考产物')
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('synthetic fixture text'), false)
  assert.equal(serialized.includes('thinking'), false)
  assert.equal(events.filter((event) => event.event.type === 'tool_execution_start').length, 1)
})

test('SEM-F29 / J23-B05–B10 deterministic Agent 模型 provider matrix preserves retry and terminal classifications', async () => {
  const service = new AgentExecutionService({ scenario: 'boundary-matrix', phase: 'matrix' })
  const input = {
    inputRef: { sessionId: 'fixture-session', inputWatermark: 1, transcriptVersion: 'original', inputDigest: 'a'.repeat(64) },
    items: [{ segmentId: 'segment-1', sourceId: 'loopback', text: 'synthetic fixture text' }]
  }
  const provider = { provider: 'deterministic-test', configuration: { provider: 'deterministic-test', baseUrl: '', model: 'fixture-model' }, apiKey: null }
  let requestOrder = 0
  const invoke = (runId) => service.handle(request(AGENT.RUN_REFERENCE, { runId, input, provider }, `request-${runId}-${++requestOrder}`))

  for (const [runId, code] of [
    ['timeout-run', 'AGENT_PROVIDER_TIMEOUT'],
    ['rate-run', 'AGENT_PROVIDER_RATE_LIMITED'],
    ['unavailable-run', 'AGENT_PROVIDER_UNAVAILABLE']
  ]) {
    const failedAttempt = await invoke(runId)
    assert.equal(failedAttempt.ok, false)
    assert.equal(failedAttempt.error.code, code)
    assert.equal((await invoke(runId)).ok, true)
  }
  for (const [runId, code] of [
    ['auth-run', 'AGENT_PROVIDER_AUTH_FAILED'],
    ['schema-run', 'AGENT_OUTPUT_INVALID'],
    ['permission-run', 'AGENT_PERMISSION_DENIED']
  ]) {
    const failed = await invoke(runId)
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, code)
  }
})

test('SEM-F29 / J23-B04 running cancellation rejects a delayed Agent 模型 provider result', async () => {
  const service = new AgentExecutionService({ scenario: 'worker-replacement', phase: 'replace' })
  const input = {
    inputRef: { sessionId: 'fixture-session', inputWatermark: 1, transcriptVersion: 'original', inputDigest: 'a'.repeat(64) },
    items: [{ segmentId: 'segment-1', sourceId: 'loopback', text: 'synthetic fixture text' }]
  }
  const provider = { provider: 'deterministic-test', configuration: { provider: 'deterministic-test', baseUrl: '', model: 'fixture-model' }, apiKey: null }
  const pending = service.handle(request(AGENT.RUN_REFERENCE, { runId: 'cancel-run', input, provider }, 'cancel-request'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(service.cancel('cancel-run').cancelled, true)
  const cancelled = await pending
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.code, 'AGENT_CANCELLED')
})

test('SEM-F29 credentials are encrypted when safeStorage is available and session-only otherwise', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vault-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const credentialPath = path.join(root, 'credential')
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(7), 'base64').toString()
  }
  const vault = new CredentialVault({ safeStorage, credentialPath })
  assert.equal(vault.set('secret-value').credentialPersisted, true)
  assert.equal(fs.readFileSync(credentialPath, 'utf8').includes('secret-value'), false)
  assert.equal(new CredentialVault({ safeStorage, credentialPath }).get(), 'secret-value')

  const sessionPath = path.join(root, 'session-only')
  const sessionVault = new CredentialVault({ safeStorage: { isEncryptionAvailable: () => false }, credentialPath: sessionPath })
  assert.equal(sessionVault.set('temporary').credentialPersisted, false)
  assert.equal(sessionVault.get(), 'temporary')
  assert.equal(fs.existsSync(sessionPath), false)
})

test('SEM-F29 provider settings require HTTPS and explicit cloud transcript disclosure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new AgentMvpSettingsStore(path.join(root, 'settings.json'))
  assert.equal(store.get().provider, 'deterministic-test')
  assert.throws(() => store.save({ provider: 'openai-compatible', baseUrl: 'http://example.test', model: 'x', cloudDisclosureAccepted: true }), { code: 'AGENT_PROVIDER_INVALID' })
  assert.throws(() => store.save({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'x', cloudDisclosureAccepted: false }), { code: 'AGENT_REQUEST_INVALID' })
  assert.equal(store.save({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'x', cloudDisclosureAccepted: true }).provider, 'openai-compatible')
})

test('SEM-F29 isolated main and preload do not import subtitle runtime or expose a credential reader', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/agent-mvp/main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '../../src/agent-mvp/preload.js'), 'utf8')
  assert.doesNotMatch(main, /require\(['"]\.\.\/main['"]\)|SessionCoordinator|audio-host|realtime-worker|refine-worker/)
  assert.doesNotMatch(preload, /getCredential|apiKey|safeStorage/)
  assert.match(main, /contextIsolation:\s*true/)
})

test('AgentMvpRuntimeHost unit: shutdown cancels work claimed after drain has begun stopping', async () => {
  let releaseClaim
  const claim = new Promise((resolve) => { releaseClaim = resolve })
  const storageOperations = []
  const agentOperations = []
  const runtime = new AgentMvpRuntimeHost({
    electron: { utilityProcess: { fork: () => { throw new Error('not started in lifecycle test') } } },
    databasePath: 'unused',
    providerSnapshot: async () => { throw new Error('provider must not be called while stopping') }
  })
  runtime.storage = {
    request: async (operation) => {
      storageOperations.push(operation)
      if (operation === STORAGE.CLAIM) return claim
      return {}
    },
    stop: async () => {}
  }
  runtime.agent = {
    request: async (operation) => { agentOperations.push(operation); return {} },
    stop: async () => {}
  }

  const draining = runtime.drain()
  const stopping = runtime.stop()
  releaseClaim({ runId: 'late-claim', lease: { owner: 'agent-mvp-runtime', expiresAt: Date.now() + 60000 } })
  await Promise.all([draining, stopping])

  assert.deepEqual(storageOperations.slice(0, 3), [STORAGE.CLAIM, STORAGE.CANCEL_REQUEST, STORAGE.CANCEL_COMMIT])
  assert.deepEqual(storageOperations.slice(3).sort(), [STORAGE.LIST_ARTIFACTS, STORAGE.LIST_JOBS, STORAGE.LIST_SESSIONS].sort())
  assert.equal(agentOperations.includes(AGENT.RUN_REFERENCE), false)
  assert.equal(runtime.running, null)
})
