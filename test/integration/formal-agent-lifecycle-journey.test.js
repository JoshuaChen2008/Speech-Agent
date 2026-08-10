'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')

const {
  AgentProviderBootstrap,
  DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG
} = require('../../src/agent-provider/provider-bootstrap')
const { CONFIG_SCHEMA_VERSION, ConfigStore } = require('../../src/main/services/config-store')
const { FormalAgentStore, makeUserRequestDigest } = require('../../src/runtime/storage-worker/formal-agent-store')
const { OPERATIONS, PROTOCOL_VERSION, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const ALL_AGENT_TASK_KINDS = Object.freeze(['enhanced-transcript', 'meeting-minutes', 'memory-extraction'])

function journeyEnvironment (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-agent-journey-'))
  const clients = []
  t.after(() => {
    for (const client of clients) {
      if (!client.service.shuttingDown) client.call(OPERATIONS.SHUTDOWN, {})
    }
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    databasePath: path.join(root, 'data', 'speech-agent.sqlite3'),
    track: (client) => {
      clients.push(client)
      return client
    }
  }
}

function serviceFor (databasePath, clock, idState) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore({
      ...options,
      migrations: FORMAL_AGENT_MIGRATIONS,
      now: () => clock.value
    }),
    agentStoreFactory: (subtitleStore) => new FormalAgentStore({
      subtitleStore,
      now: () => clock.value,
      idFactory: () => `formal-id-${String(++idState.value).padStart(6, '0')}`
    })
  })
  let requestNumber = 0
  const raw = (operation, payload, idempotencyKey) => {
    const normalizedPayload = operation === OPERATIONS.AGENT_CLAIM_NEXT_JOB &&
      !Object.hasOwn(payload, 'availableTaskKinds')
      ? { ...payload, availableTaskKinds: ALL_AGENT_TASK_KINDS }
      : payload
    const request = {
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `formal-request-${++requestNumber}`,
      operation,
      payload: normalizedPayload
    }
    if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey
    return service.handle(request)
  }
  const call = (operation, payload, idempotencyKey) => {
    const response = raw(operation, payload, idempotencyKey)
    assert.equal(response.ok, true, JSON.stringify(response.error))
    return response.result
  }
  call(OPERATIONS.INITIALIZE, { databasePath })
  return { service, call, raw }
}

function cloudContext (overrides = {}) {
  const context = {
    agentEnabled: true,
    memoryEnabled: true,
    automaticProcessingSince: 0,
    memoryProcessingSince: 0,
    providerId: 'cloud-primary',
    providerKind: 'cloud',
    model: 'model-primary',
    cloudDisclosureAccepted: true,
    credentialAvailable: true,
    localModelReady: false,
    ...overrides
  }
  if (!context.agentEnabled) {
    context.automaticProcessingSince = null
    context.memoryProcessingSince = null
  } else if (!context.memoryEnabled) {
    context.memoryProcessingSince = null
  }
  return context
}

function localContext (overrides = {}) {
  const context = {
    agentEnabled: true,
    memoryEnabled: true,
    automaticProcessingSince: 0,
    memoryProcessingSince: 0,
    providerId: 'local-primary',
    providerKind: 'local',
    model: 'local-model',
    cloudDisclosureAccepted: false,
    credentialAvailable: false,
    localModelReady: true,
    ...overrides
  }
  if (!context.agentEnabled) {
    context.automaticProcessingSince = null
    context.memoryProcessingSince = null
  } else if (!context.memoryEnabled) {
    context.memoryProcessingSince = null
  }
  return context
}

function eligibilityContextFromAgentSettings (settings, bootstrap) {
  return {
    agentEnabled: settings.agentEnabled,
    memoryEnabled: settings.memoryEnabled,
    automaticProcessingSince: settings.automaticProcessingSince,
    memoryProcessingSince: settings.memoryProcessingSince,
    ...bootstrap.getEligibilityProviderFacts(),
    cloudDisclosureAccepted: settings.cloudDisclosureAccepted,
    localModelReady: false
  }
}

function createSession (client, {
  sessionId,
  captions = [],
  refinedCaptionIndexes = [],
  startedAt = 100,
  endedAt = 200,
  close = true
}) {
  client.call(
    OPERATIONS.OPEN_SESSION,
    { sessionId, sourceId: 'loopback', startedAt, refinementEnabled: refinedCaptionIndexes.length > 0 },
    makeOpenSessionKey(sessionId)
  )
  captions.forEach((text, index) => {
    const event = {
      schemaVersion: 1,
      sessionId,
      sourceId: 'loopback',
      segmentId: `segment-${index + 1}`,
      sequence: index + 1,
      revision: 1,
      kind: 'final',
      t0: index,
      t1: index + 1,
      text,
      translation: null
    }
    client.call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))
  })
  refinedCaptionIndexes.forEach((captionIndex, index) => {
    const event = {
      schemaVersion: 1,
      sessionId,
      sourceId: 'loopback',
      segmentId: `segment-${captionIndex + 1}`,
      sequence: captions.length + index + 1,
      revision: 2,
      kind: 'refined',
      t0: captionIndex,
      t1: captionIndex + 1,
      text: `synthetic refined segment ${captionIndex + 1}`,
      translation: null
    }
    client.call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))
  })
  if (close) {
    client.call(
      OPERATIONS.CLOSE_SESSION,
      { sessionId, sourceId: 'loopback', endedAt, state: 'closed' },
      makeCloseSessionKey(sessionId)
    )
  }
}

test('SEM-F28/SEM-T15 / D9/J24-B23/B26/B30 在配置校验前消费启动环境凭据并为三项后台 Agent 任务冻结 DeepSeek 快照', async (t) => {
  const credentialName = 'DEEPSEEK_API_KEY'
  const credentialCanary = 'd9-synthetic-startup-credential'
  const startupEnvironment = {
    D9_NON_SECRET: 'preserved',
    [credentialName]: credentialCanary
  }
  let catalogReadAfterCredentialDeletion = false
  const observedCatalog = new Proxy(DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG, {
    ownKeys (target) {
      catalogReadAfterCredentialDeletion = !Object.keys(startupEnvironment)
        .some((key) => key.toUpperCase() === credentialName)
      return Reflect.ownKeys(target)
    }
  })
  const bootstrap = new AgentProviderBootstrap({
    environment: startupEnvironment,
    configCatalog: observedCatalog
  })
  t.after(() => bootstrap.dispose())

  assert.equal(catalogReadAfterCredentialDeletion, true)
  assert.equal(Object.keys(startupEnvironment).some((key) => key.toUpperCase() === credentialName), false)
  assert.deepEqual(bootstrap.getPublicState(), {
    provider: {
      providerId: 'deepseek',
      providerKind: 'cloud',
      model: 'deepseek-v4-flash'
    },
    configurationSource: 'trusted_config_table',
    credentialState: 'startup_environment'
  })
  assert.deepEqual(bootstrap.getEligibilityProviderFacts(), {
    providerId: 'deepseek',
    providerKind: 'cloud',
    model: 'deepseek-v4-flash',
    credentialAvailable: true
  })
  assert.deepEqual(bootstrap.getProviderConfig(), {
    providerId: 'deepseek',
    providerKind: 'cloud',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    maxChunkInputBytes: 65536,
    maxResultBytes: 16384,
    timeoutMs: 60000
  })
  assert.equal(Object.isFrozen(bootstrap.getProviderConfig()), true)
  const initialChildEnvironment = bootstrap.getChildEnvironment()
  assert.equal(Object.isFrozen(initialChildEnvironment), true)
  assert.deepEqual(initialChildEnvironment, { D9_NON_SECRET: 'preserved' })

  startupEnvironment[credentialName] = 'd9-runtime-injection-must-not-win'
  assert.deepEqual(bootstrap.getChildEnvironment(), { D9_NON_SECRET: 'preserved' })
  let successfulCredentialCopy
  assert.equal(await bootstrap.withCredential(async (credential) => {
    successfulCredentialCopy = credential
    assert.equal(Buffer.isBuffer(credential), true)
    assert.equal(credential.toString('utf8'), credentialCanary)
    return 'borrow-succeeded'
  }), 'borrow-succeeded')
  assert.equal(successfulCredentialCopy.every((byte) => byte === 0), true)

  let failedCredentialCopy
  await assert.rejects(bootstrap.withCredential(async (credential) => {
    failedCredentialCopy = credential
    throw new Error('synthetic-provider-failure')
  }), /synthetic-provider-failure/)
  assert.equal(failedCredentialCopy.every((byte) => byte === 0), true)

  const credentialAt4096Bytes = `${'密'.repeat(1365)}a`
  const credentialAt4097Bytes = `${credentialAt4096Bytes}a`
  assert.equal(Buffer.byteLength(credentialAt4096Bytes, 'utf8'), 4096)
  assert.equal(Buffer.byteLength(credentialAt4097Bytes, 'utf8'), 4097)
  const credentialClassifications = [
    { name: 'missing', environment: { D9_CASE: 'missing' }, state: 'missing', available: false },
    { name: 'blank', environment: { [credentialName]: ' \t\r\n ' }, state: 'invalid', available: false },
    { name: '4096-byte', environment: { [credentialName]: credentialAt4096Bytes }, state: 'startup_environment', available: true },
    { name: '4097-byte', environment: { [credentialName]: credentialAt4097Bytes }, state: 'invalid', available: false },
    { name: 'lowercase', environment: { deepseek_api_key: credentialCanary }, state: 'startup_environment', available: true },
    {
      name: 'case-duplicate',
      environment: { [credentialName]: credentialCanary, deepseek_api_key: 'd9-conflicting-credential' },
      state: 'invalid',
      available: false
    },
    { name: 'non-string', environment: { [credentialName]: Buffer.from('synthetic') }, state: 'invalid', available: false }
  ]
  for (const scenario of credentialClassifications) {
    const classified = new AgentProviderBootstrap({ environment: scenario.environment })
    assert.equal(classified.getPublicState().credentialState, scenario.state, scenario.name)
    assert.equal(classified.getEligibilityProviderFacts().credentialAvailable, scenario.available, scenario.name)
    assert.equal(Object.keys(scenario.environment).some((key) => key.toUpperCase() === credentialName), false, scenario.name)
    classified.dispose()
  }

  const defaultProvider = DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG.providers[0]
  const invalidCatalogs = [
    {
      name: 'top-level-unknown-field',
      catalog: {
        ...DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG,
        unexpected: true
      }
    },
    {
      name: 'unknown-field',
      catalog: {
        schemaVersion: 1,
        providers: [{ ...defaultProvider, unexpected: true }]
      }
    },
    {
      name: 'exact-origin-drift',
      catalog: {
        schemaVersion: 1,
        providers: [{ ...defaultProvider, baseUrl: 'https://api.deepseek.com.evil.example' }]
      }
    },
    {
      name: 'schema-version-drift',
      catalog: {
        schemaVersion: 2,
        providers: [{ ...defaultProvider }]
      }
    },
    {
      name: 'provider-count-drift',
      catalog: {
        schemaVersion: 1,
        providers: [{ ...defaultProvider }, { ...defaultProvider }]
      }
    },
    {
      name: 'provider-budget-drift',
      catalog: {
        schemaVersion: 1,
        providers: [{ ...defaultProvider, maxChunkInputBytes: 255 }]
      }
    }
  ]
  for (const scenario of invalidCatalogs) {
    const environment = { [credentialName]: credentialCanary }
    const rejected = new AgentProviderBootstrap({
      environment,
      configCatalog: scenario.catalog
    })
    assert.equal(rejected.getPublicState().provider, null, scenario.name)
    assert.equal(rejected.getProviderConfig(), null, scenario.name)
    assert.deepEqual(rejected.getEligibilityProviderFacts(), {
      providerId: null,
      providerKind: null,
      model: null,
      credentialAvailable: false
    }, scenario.name)
    assert.equal(Object.keys(environment).some((key) => key.toUpperCase() === credentialName), false, scenario.name)
    await assert.rejects(
      rejected.withCredential(async () => 'must-not-run'),
      (error) => error?.code === 'AGENT_PROVIDER_AUTH_FAILED'
    )
    rejected.dispose()
  }

  const concurrentEnvironment = { [credentialName]: credentialCanary }
  const concurrentBootstrap = new AgentProviderBootstrap({ environment: concurrentEnvironment })
  const concurrentCopies = []
  let releaseConcurrentBorrows
  const concurrentBorrowRelease = new Promise((resolve) => { releaseConcurrentBorrows = resolve })
  let reportBothBorrowed
  const bothBorrowed = new Promise((resolve) => { reportBothBorrowed = resolve })
  const borrowConcurrently = (result) => concurrentBootstrap.withCredential(async (credential) => {
    concurrentCopies.push(credential)
    if (concurrentCopies.length === 2) reportBothBorrowed()
    await concurrentBorrowRelease
    return result
  })
  const concurrentBorrows = [borrowConcurrently('first'), borrowConcurrently('second')]
  await bothBorrowed
  assert.equal(concurrentCopies.length, 2)
  assert.equal(concurrentCopies.every((credential) => credential.toString('utf8') === credentialCanary), true)
  concurrentBootstrap.invalidateCredential()
  assert.equal(concurrentCopies.every((credential) => credential.every((byte) => byte === 0)), true)
  assert.equal(concurrentBootstrap.getPublicState().credentialState, 'invalid')
  releaseConcurrentBorrows()
  assert.deepEqual(await Promise.all(concurrentBorrows), ['first', 'second'])
  assert.equal(concurrentCopies.every((credential) => credential.every((byte) => byte === 0)), true)
  concurrentEnvironment[credentialName] = 'd9-concurrent-runtime-injection-must-not-win'
  assert.equal(concurrentBootstrap.getEligibilityProviderFacts().credentialAvailable, false)
  assert.equal(Object.hasOwn(concurrentBootstrap.getChildEnvironment(), credentialName), false)
  concurrentBootstrap.dispose()

  const clock = { value: 9500 }
  const journey = journeyEnvironment(t)
  const client = journey.track(serviceFor(journey.databasePath, clock, { value: 0 }))
  const readyContext = cloudContext(bootstrap.getEligibilityProviderFacts())
  createSession(client, {
    sessionId: 'd9-provider-ready',
    captions: ['synthetic D9 provider startup boundary']
  })
  assert.equal(client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'd9-provider-ready',
    requestedBy: 'automatic',
    eligibilityContext: readyContext
  }).eligibility, 'ready')
  const reconciled = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'd9-provider-ready',
    requestedBy: 'automatic',
    eligibilityContext: readyContext
  })
  assert.equal(reconciled.jobs.length, 3)
  assert.equal(reconciled.jobs.every(({ job }) =>
    job.providerId === 'deepseek' &&
    job.providerKind === 'cloud' &&
    job.model === 'deepseek-v4-flash'
  ), true)

  client.service.store.database.exec('PRAGMA wal_checkpoint(FULL)')
  const credentialBytes = Buffer.from(credentialCanary, 'utf8')
  for (const databaseFile of [journey.databasePath, `${journey.databasePath}-wal`, `${journey.databasePath}-shm`]) {
    if (fs.existsSync(databaseFile)) {
      assert.equal(fs.readFileSync(databaseFile).includes(credentialBytes), false)
    }
  }

  bootstrap.invalidateCredential()
  assert.equal(bootstrap.getPublicState().credentialState, 'invalid')
  assert.equal(bootstrap.getEligibilityProviderFacts().credentialAvailable, false)
  startupEnvironment[credentialName] = 'd9-second-runtime-injection-must-not-win'
  assert.deepEqual(bootstrap.getChildEnvironment(), { D9_NON_SECRET: 'preserved' })
  await assert.rejects(
    bootstrap.withCredential(async () => 'must-not-run'),
    (error) => error?.code === 'AGENT_PROVIDER_AUTH_FAILED'
  )

  createSession(client, {
    sessionId: 'd9-provider-invalidated',
    captions: ['synthetic D9 invalidated credential boundary'],
    startedAt: 300,
    endedAt: 400
  })
  const unavailable = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'd9-provider-invalidated',
    requestedBy: 'automatic',
    eligibilityContext: cloudContext(bootstrap.getEligibilityProviderFacts())
  })
  assert.equal(unavailable.eligibility, 'credential_unavailable')
  assert.deepEqual(unavailable.jobs, [])
  assert.equal(Number(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_jobs').get().count), 3)
})

test('SEM-F28 / J24-B01/B26 preserves eligibility priority and subtitle independence', (t) => {
  const clock = { value: 10000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))

  createSession(client, { sessionId: 'active-empty', close: false })
  assert.equal(client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'active-empty',
    requestedBy: 'automatic',
    eligibilityContext: cloudContext({ agentEnabled: false, providerId: null, providerKind: null, model: null })
  }).eligibility, 'session_not_terminal')
  client.call(
    OPERATIONS.CLOSE_SESSION,
    { sessionId: 'active-empty', sourceId: 'loopback', endedAt: 200, state: 'closed' },
    makeCloseSessionKey('active-empty')
  )
  assert.equal(client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'active-empty', requestedBy: 'automatic', eligibilityContext: cloudContext()
  }).eligibility, 'no_committed_transcript')

  createSession(client, { sessionId: 'eligible-session', captions: ['synthetic eligibility transcript'] })
  const evaluate = (context, requestedBy = 'automatic') => client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'eligible-session', requestedBy, eligibilityContext: context
  }).eligibility
  assert.equal(evaluate(cloudContext({ automaticProcessingSince: 201 })), 'outside_automatic_window')
  assert.equal(evaluate(cloudContext({ agentEnabled: false })), 'agent_disabled')
  assert.equal(evaluate(cloudContext({ providerId: null, providerKind: null, model: null })), 'provider_not_configured')
  assert.equal(evaluate(cloudContext({ cloudDisclosureAccepted: false })), 'cloud_disclosure_required')
  assert.equal(evaluate(cloudContext({ credentialAvailable: false })), 'credential_unavailable')
  assert.equal(evaluate(localContext({ localModelReady: false })), 'local_model_not_ready')
  assert.equal(evaluate(cloudContext()), 'ready')
  assert.equal(evaluate(cloudContext({ automaticProcessingSince: 201 }), 'user'), 'ready')

  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_jobs').get().count, 0)
  assert.equal(client.call(OPERATIONS.GET_SESSION, { sessionId: 'eligible-session' }).segments.length, 1)
})

test('SEM-F28 / J24-B04/B25/B13 reconciles three frozen independent jobs exactly once', (t) => {
  const clock = { value: 20000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, {
    sessionId: 'automatic-session',
    captions: ['synthetic first segment', 'synthetic second segment']
  })

  const first = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'automatic-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  assert.equal(first.eligibility, 'ready')
  assert.deepEqual(first.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'memory-extraction', 'enhanced-transcript'
  ])
  assert.equal(new Set(first.jobs.map((entry) => entry.job.inputRef.inputDigest)).size, 1)
  assert.equal(first.jobs.every((entry) => entry.status === 'created'), true)

  const replay = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'automatic-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  assert.deepEqual(replay.jobs.map((entry) => entry.job.runId), first.jobs.map((entry) => entry.job.runId))
  assert.equal(replay.jobs.every((entry) => entry.status === 'already_processed'), true)

  const changedSettings = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'automatic-session',
    requestedBy: 'automatic',
    eligibilityContext: cloudContext({ providerId: 'cloud-next', model: 'model-next' })
  })
  assert.deepEqual(changedSettings.jobs.map((entry) => entry.job.runId), first.jobs.map((entry) => entry.job.runId))
  assert.equal(changedSettings.jobs.every((entry) => entry.job.providerId === 'cloud-primary'), true)
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_jobs').get().count, 3)
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM caption_events').get().count, 2)

  const credentialCanary = 'credential-canary-must-not-escape'
  const rejected = client.raw(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'automatic-session',
    requestedBy: 'automatic',
    eligibilityContext: { ...cloudContext(), apiKey: credentialCanary }
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'AGENT_REQUEST_INVALID')
  assert.equal(JSON.stringify(rejected).includes(credentialCanary), false)
})

test('SEM-F28 / J24-B07/B08/B29 makes manual requests idempotent and rejects stale input', (t) => {
  const clock = { value: 30000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, { sessionId: 'manual-session', captions: ['synthetic manual transcript'] })
  const context = cloudContext()
  const inputRef = client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'manual-session', requestedBy: 'user', eligibilityContext: context
  }).inputRef
  const payload = {
    inputRef,
    taskKind: 'meeting-minutes',
    clientIdempotencyKey: 'manual-action-1',
    requestDigest: makeUserRequestDigest({ inputRef, taskKind: 'meeting-minutes', eligibilityContext: context }),
    eligibilityContext: context
  }
  const created = client.call(OPERATIONS.AGENT_REQUEST_JOB, payload)
  const replay = client.call(OPERATIONS.AGENT_REQUEST_JOB, payload)
  assert.equal(created.status, 'created')
  assert.equal(replay.status, 'already_processed')
  assert.equal(replay.job.runId, created.job.runId)

  const conflicting = {
    ...payload,
    taskKind: 'enhanced-transcript',
    requestDigest: makeUserRequestDigest({ inputRef, taskKind: 'enhanced-transcript', eligibilityContext: context })
  }
  assert.equal(client.raw(OPERATIONS.AGENT_REQUEST_JOB, conflicting).error.code, 'AGENT_REQUEST_INVALID')

  const staleRef = { ...inputRef, inputWatermark: inputRef.inputWatermark + 1, inputDigest: 'f'.repeat(64) }
  const stale = {
    inputRef: staleRef,
    taskKind: 'meeting-minutes',
    clientIdempotencyKey: 'manual-action-stale',
    requestDigest: makeUserRequestDigest({ inputRef: staleRef, taskKind: 'meeting-minutes', eligibilityContext: context }),
    eligibilityContext: context
  }
  assert.equal(client.raw(OPERATIONS.AGENT_REQUEST_JOB, stale).error.code, 'AGENT_INPUT_CHANGED')

  const missingProviderContext = cloudContext({ providerId: null, providerKind: null, model: null })
  const notEligible = client.call(OPERATIONS.AGENT_REQUEST_JOB, {
    inputRef,
    taskKind: 'meeting-minutes',
    clientIdempotencyKey: 'manual-action-no-provider',
    requestDigest: makeUserRequestDigest({
      inputRef,
      taskKind: 'meeting-minutes',
      eligibilityContext: missingProviderContext
    }),
    eligibilityContext: missingProviderContext
  })
  assert.equal(notEligible.status, 'not_eligible')
  assert.equal(notEligible.eligibility, 'provider_not_configured')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_jobs').get().count, 1)
})

test('SEM-F28 / J24-B05/B09/B12 recovers one run across restart and closes cancellation races', (t) => {
  const environment = journeyEnvironment(t)
  const databasePath = environment.databasePath
  const clock = { value: 40000 }
  const idState = { value: 0 }
  const firstClient = environment.track(serviceFor(databasePath, clock, idState))
  createSession(firstClient, { sessionId: 'local-session', captions: ['synthetic local transcript'] })
  const reconciled = firstClient.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'local-session', requestedBy: 'automatic', eligibilityContext: localContext()
  })
  firstClient.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: localContext() })
  assert.equal(firstClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'restart-claim-local-blocked',
    owner: 'worker-before-restart', leaseMs: 1000, localWorkAllowed: false
  }), null)
  const claimed = firstClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'restart-claim-before',
    owner: 'worker-before-restart', leaseMs: 1000, localWorkAllowed: true
  })
  assert.equal(claimed.runId, reconciled.jobs[0].job.runId)
  firstClient.call(OPERATIONS.SHUTDOWN, {})

  clock.value = 41001
  const secondClient = environment.track(serviceFor(databasePath, clock, idState))
  assert.equal(secondClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'restart-claim-without-policy',
    owner: 'worker-after-restart', leaseMs: 1000, localWorkAllowed: true
  }), null)
  secondClient.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: localContext() })
  const recovered = secondClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'restart-claim-after',
    owner: 'worker-after-restart', leaseMs: 1000, localWorkAllowed: true
  })
  assert.equal(recovered.runId, claimed.runId)
  assert.equal(recovered.attemptCount, 2)
  assert.notDeepEqual(recovered.lease, claimed.lease)

  const cancelRequested = secondClient.call(OPERATIONS.AGENT_REQUEST_CANCEL, { runId: recovered.runId })
  assert.equal(cancelRequested.state, 'running')
  assert.equal(secondClient.raw(OPERATIONS.AGENT_MARK_JOB_FAILED, {
    runId: recovered.runId,
    lease: recovered.lease,
    errorCode: 'AGENT_INTERNAL_FAILURE'
  }).error.code, 'AGENT_JOB_STATE_CONFLICT')
  const cancelled = secondClient.call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, {
    runId: recovered.runId,
    lease: recovered.lease
  })
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.errorCode, null)
  assert.deepEqual(secondClient.call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, {
    runId: recovered.runId,
    lease: recovered.lease
  }), cancelled)

  const queuedRun = reconciled.jobs[1].job.runId
  assert.equal(secondClient.call(OPERATIONS.AGENT_REQUEST_CANCEL, { runId: queuedRun }).state, 'cancelled')
  const replay = secondClient.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'local-session', requestedBy: 'automatic', eligibilityContext: localContext()
  })
  assert.equal(replay.jobs.find((entry) => entry.job.runId === queuedRun).job.state, 'cancelled')
  secondClient.call(OPERATIONS.SHUTDOWN, {})

  const inspect = new DatabaseSync(databasePath)
  try {
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE state = 'cancelled'").get().count, 2)
    assert.equal(inspect.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    inspect.close()
  }
})

test('SEM-F26/SEM-F28/SEM-T15 / D11/J24-B14/B23/B26/B30 将 ConfigStore v2 设置边界应用到真实后台 Agent 任务', (t) => {
  const clock = { value: 500 }
  const environment = journeyEnvironment(t)
  const configPath = path.join(path.dirname(environment.databasePath), 'config.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    onboardingCompleted: true,
    onboardingPreset: 'meeting',
    fontSize: 38,
    opacity: 0.5,
    refinementEnabled: true,
    mic: true,
    loopback: false
  }), 'utf8')
  const configStore = new ConfigStore(configPath, { now: () => clock.value })
  const migrated = configStore.load()
  assert.equal(migrated.schemaVersion, CONFIG_SCHEMA_VERSION)
  assert.equal(migrated.onboardingPreset, 'meeting')
  assert.equal(migrated.fontSize, 38)
  assert.equal(migrated.opacity, 0.5)
  assert.equal(migrated.refinementEnabled, true)
  assert.equal(migrated.mic, false)
  assert.equal(migrated.loopback, true)
  assert.deepEqual({
    agentEnabled: migrated.agentEnabled,
    automaticProcessingSince: migrated.automaticProcessingSince,
    memoryEnabled: migrated.memoryEnabled,
    memoryProcessingSince: migrated.memoryProcessingSince,
    cloudDisclosureAccepted: migrated.cloudDisclosureAccepted,
    agentSettingsRevision: migrated.agentSettingsRevision
  }, {
    agentEnabled: false,
    automaticProcessingSince: null,
    memoryEnabled: true,
    memoryProcessingSince: null,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  })
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion, CONFIG_SCHEMA_VERSION)
  assert.deepEqual(
    new ConfigStore(configPath, { now: () => clock.value }).load(),
    migrated
  )

  const credentialCanary = 'd11-synthetic-startup-credential'
  const bootstrap = new AgentProviderBootstrap({
    environment: { DEEPSEEK_API_KEY: credentialCanary }
  })
  t.after(() => bootstrap.dispose())
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))

  createSession(client, {
    sessionId: 'settings-before-enable',
    captions: ['synthetic settings boundary before enable'],
    startedAt: 300,
    endedAt: 400
  })
  assert.equal(client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'settings-before-enable',
    requestedBy: 'automatic',
    eligibilityContext: eligibilityContextFromAgentSettings(migrated, bootstrap)
  }).eligibility, 'agent_disabled')

  assert.throws(() => configStore.update({ agentEnabled: true }), /not allowed/)
  assert.throws(() => configStore.update({ model: 'deepseek-v4-flash' }), /not allowed/)
  assert.throws(() => configStore.updateAgentSettings({
    expectedRevision: 0,
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: true,
    apiKey: 'must-not-enter-config'
  }), /must contain exactly/)

  const enabled = configStore.updateAgentSettings({
    expectedRevision: 0,
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: true
  })
  assert.equal(enabled.automaticProcessingSince, 500)
  assert.equal(enabled.memoryProcessingSince, 500)
  assert.equal(enabled.agentSettingsRevision, 1)
  const enabledContext = eligibilityContextFromAgentSettings(enabled, bootstrap)
  assert.equal(client.call(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 'settings-before-enable',
    requestedBy: 'automatic',
    eligibilityContext: enabledContext
  }).eligibility, 'outside_automatic_window')

  const beforeConflict = fs.readFileSync(configPath)
  assert.throws(() => configStore.updateAgentSettings({
    expectedRevision: 0,
    agentEnabled: true,
    memoryEnabled: false,
    cloudDisclosureAccepted: true
  }), (error) => error?.code === 'SETTINGS_REVISION_CONFLICT')
  assert.deepEqual(fs.readFileSync(configPath), beforeConflict)

  clock.value = 550
  createSession(client, {
    sessionId: 'memory-policy-session',
    captions: ['synthetic memory policy transcript'],
    startedAt: 501,
    endedAt: 550
  })
  const reconciled = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-policy-session', requestedBy: 'automatic', eligibilityContext: enabledContext
  })
  assert.equal(reconciled.jobs.length, 3)
  assert.equal(reconciled.jobs.every(({ job }) =>
    job.providerId === 'deepseek' && job.providerKind === 'cloud' && job.model === 'deepseek-v4-flash'
  ), true)
  assert.equal(new Set(reconciled.jobs.map(({ job }) => JSON.stringify(job.inputRef))).size, 1)
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: enabledContext })

  const minutes = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'policy-claim-minutes',
    owner: 'policy-worker', leaseMs: 1000, localWorkAllowed: false
  })
  client.call(OPERATIONS.AGENT_MARK_JOB_FAILED, {
    runId: minutes.runId,
    lease: minutes.lease,
    errorCode: 'AGENT_OUTPUT_INVALID'
  })
  const memory = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'policy-claim-memory',
    owner: 'policy-worker', leaseMs: 1000, localWorkAllowed: false
  })
  assert.equal(memory.taskKind, 'memory-extraction')

  clock.value = 600
  const memoryDisabled = configStore.updateAgentSettings({
    expectedRevision: 1,
    agentEnabled: true,
    memoryEnabled: false,
    cloudDisclosureAccepted: true
  })
  assert.equal(memoryDisabled.automaticProcessingSince, 500)
  assert.equal(memoryDisabled.memoryProcessingSince, null)
  assert.equal(memoryDisabled.agentSettingsRevision, 2)
  const memoryDisabledContext = eligibilityContextFromAgentSettings(memoryDisabled, bootstrap)
  assert.deepEqual(client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: memoryDisabledContext
  }), { queuedCancelled: 0, runningCancellationRequested: 1 })
  assert.equal(client.raw(OPERATIONS.AGENT_MARK_JOB_FAILED, {
    runId: memory.runId,
    lease: memory.lease,
    errorCode: 'AGENT_INTERNAL_FAILURE'
  }).error.code, 'AGENT_JOB_STATE_CONFLICT')
  assert.equal(client.call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, {
    runId: memory.runId,
    lease: memory.lease
  }).state, 'cancelled')

  clock.value = 650
  createSession(client, {
    sessionId: 'memory-disabled-period',
    captions: ['synthetic disabled-period transcript'],
    startedAt: 601,
    endedAt: 650
  })
  const disabledPeriod = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-disabled-period',
    requestedBy: 'automatic',
    eligibilityContext: memoryDisabledContext
  })
  assert.deepEqual(disabledPeriod.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'enhanced-transcript'
  ])

  clock.value = 700
  const memoryReenabled = configStore.updateAgentSettings({
    expectedRevision: 2,
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: true
  })
  assert.equal(memoryReenabled.automaticProcessingSince, 500)
  assert.equal(memoryReenabled.memoryProcessingSince, 700)
  assert.equal(memoryReenabled.agentSettingsRevision, 3)
  const memoryReenabledContext = eligibilityContextFromAgentSettings(memoryReenabled, bootstrap)
  assert.equal(client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: memoryReenabledContext
  }).queuedCancelled, 0)
  const disabledPeriodReplay = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-disabled-period',
    requestedBy: 'automatic',
    eligibilityContext: memoryReenabledContext
  })
  assert.deepEqual(disabledPeriodReplay.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'enhanced-transcript'
  ])
  const memoryRow = client.service.store.database.prepare(
    "SELECT state FROM agent_jobs WHERE session_id = ? AND plugin_id = 'memory-extraction'"
  ).get('memory-policy-session')
  assert.equal(memoryRow.state, 'cancelled')

  clock.value = 750
  createSession(client, {
    sessionId: 'memory-after-reenable',
    captions: ['synthetic post-boundary transcript'],
    startedAt: 701,
    endedAt: 750
  })
  const afterReenable = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-after-reenable',
    requestedBy: 'automatic',
    eligibilityContext: memoryReenabledContext
  })
  assert.deepEqual(afterReenable.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'memory-extraction', 'enhanced-transcript'
  ])

  const enhanced = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'policy-claim-enhanced',
    owner: 'policy-worker', leaseMs: 1000, localWorkAllowed: false
  })
  assert.equal(enhanced.taskKind, 'enhanced-transcript')
  clock.value = 800
  const agentDisabled = configStore.updateAgentSettings({
    expectedRevision: 3,
    agentEnabled: false,
    memoryEnabled: true,
    cloudDisclosureAccepted: true
  })
  assert.equal(agentDisabled.automaticProcessingSince, null)
  assert.equal(agentDisabled.memoryProcessingSince, null)
  assert.equal(agentDisabled.agentSettingsRevision, 4)
  const disabledResult = client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: eligibilityContextFromAgentSettings(agentDisabled, bootstrap)
  })
  assert.equal(disabledResult.runningCancellationRequested, 1)
  assert.equal(disabledResult.queuedCancelled > 0, true)
  assert.equal(client.call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, {
    runId: enhanced.runId,
    lease: enhanced.lease
  }).state, 'cancelled')

  client.service.store.database.exec('PRAGMA wal_checkpoint(FULL)')
  const credentialBytes = Buffer.from(credentialCanary, 'utf8')
  const providerUrlBytes = Buffer.from('https://api.deepseek.com', 'utf8')
  const configBytes = fs.readFileSync(configPath)
  assert.equal(configBytes.includes(credentialBytes), false)
  assert.equal(configBytes.includes(providerUrlBytes), false)
  assert.equal(configBytes.includes(Buffer.from('deepseek-v4-flash', 'utf8')), false)
  for (const databaseFile of [environment.databasePath, `${environment.databasePath}-wal`, `${environment.databasePath}-shm`]) {
    if (!fs.existsSync(databaseFile)) continue
    const databaseBytes = fs.readFileSync(databaseFile)
    assert.equal(databaseBytes.includes(credentialBytes), false)
    assert.equal(databaseBytes.includes(providerUrlBytes), false)
  }
})

test('SEM-F28 / J24-B11/B18 keeps retry errors bounded and does not starve later sessions', (t) => {
  const clock = { value: 50000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, { sessionId: 'fifo-first', captions: ['synthetic first queue transcript'] })
  client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'fifo-first', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  clock.value += 1
  createSession(client, { sessionId: 'fifo-second', captions: ['synthetic second queue transcript'], startedAt: 300, endedAt: 400 })
  client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'fifo-second', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })

  const first = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'fifo-claim-1',
    owner: 'fifo-worker', leaseMs: 1000, localWorkAllowed: false
  })
  assert.equal(first.sessionId, 'fifo-first')
  const retry = client.call(OPERATIONS.AGENT_MARK_JOB_RETRY, {
    runId: first.runId,
    lease: first.lease,
    errorCode: 'AGENT_PROVIDER_TIMEOUT',
    nextAttemptAt: clock.value + 5000
  })
  assert.equal(retry.state, 'retry_wait')
  assert.equal(retry.runId, first.runId)
  assert.deepEqual(client.call(OPERATIONS.AGENT_MARK_JOB_RETRY, {
    runId: first.runId,
    lease: first.lease,
    errorCode: 'AGENT_PROVIDER_TIMEOUT',
    nextAttemptAt: clock.value + 5000
  }), retry)

  const terminalRuns = []
  while (terminalRuns.length < 2) {
    const job = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
      claimIdempotencyKey: `fifo-claim-${terminalRuns.length + 2}`,
      owner: 'fifo-worker', leaseMs: 1000, localWorkAllowed: false
    })
    assert.equal(job.sessionId, 'fifo-first')
    const failedPayload = {
      runId: job.runId,
      lease: job.lease,
      errorCode: 'AGENT_OUTPUT_INVALID'
    }
    const failed = client.call(OPERATIONS.AGENT_MARK_JOB_FAILED, failedPayload)
    assert.deepEqual(client.call(OPERATIONS.AGENT_MARK_JOB_FAILED, failedPayload), failed)
    terminalRuns.push(failed)
  }
  assert.equal(terminalRuns.every((job) => job.state === 'failed'), true)

  const laterSession = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'fifo-claim-4',
    owner: 'fifo-worker', leaseMs: 1000, localWorkAllowed: false
  })
  assert.equal(laterSession.sessionId, 'fifo-second')
  assert.equal(client.raw(OPERATIONS.AGENT_MARK_JOB_RETRY, {
    runId: laterSession.runId,
    lease: laterSession.lease,
    errorCode: 'AGENT_OUTPUT_INVALID',
    nextAttemptAt: clock.value + 1000
  }).error.code, 'AGENT_REQUEST_INVALID')
})

test('SEM-F28 / J24-B05 linearizes policy changes and claim reply replay without claiming the next job', (t) => {
  const clock = { value: 60000 }
  const environment = journeyEnvironment(t)
  const databasePath = environment.databasePath
  const idState = { value: 0 }
  const firstClient = environment.track(serviceFor(databasePath, clock, idState))
  createSession(firstClient, { sessionId: 'claim-replay-session', captions: ['synthetic claim replay'] })
  firstClient.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'claim-replay-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })

  firstClient.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: cloudContext({ credentialAvailable: false })
  })
  const blockedPayload = {
    claimIdempotencyKey: 'claim-empty-before-ready',
    owner: 'claim-worker',
    leaseMs: 1000,
    localWorkAllowed: false
  }
  assert.equal(firstClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, blockedPayload), null)
  firstClient.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  assert.equal(firstClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, blockedPayload), null)

  const claimPayload = {
    claimIdempotencyKey: 'claim-committed-reply-lost',
    owner: 'claim-worker',
    leaseMs: 1000,
    localWorkAllowed: false
  }
  const claimed = firstClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, claimPayload)
  firstClient.call(OPERATIONS.SHUTDOWN, {})

  const secondClient = environment.track(serviceFor(databasePath, clock, idState))
  const replay = secondClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, claimPayload)
  assert.equal(replay.runId, claimed.runId)
  assert.deepEqual(replay.lease, claimed.lease)
  assert.equal(secondClient.raw(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    ...claimPayload,
    leaseMs: 2000
  }).error.code, 'AGENT_REQUEST_INVALID')

  secondClient.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  const next = secondClient.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'claim-next-after-replay',
    owner: 'claim-worker',
    leaseMs: 1000,
    localWorkAllowed: false
  })
  assert.notEqual(next.runId, claimed.runId)
})

test('SEM-F28 / J24-B21 rejects an incomplete refined mixed view as Agent input', (t) => {
  const clock = { value: 80000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, {
    sessionId: 'partial-refined-session',
    captions: ['synthetic original one', 'synthetic original two'],
    refinedCaptionIndexes: [0]
  })
  const context = cloudContext()
  const refinedRef = {
    sessionId: 'partial-refined-session',
    inputWatermark: 3,
    transcriptVersion: 'refined',
    inputDigest: 'a'.repeat(64)
  }
  const response = client.raw(OPERATIONS.AGENT_REQUEST_JOB, {
    inputRef: refinedRef,
    taskKind: 'meeting-minutes',
    clientIdempotencyKey: 'partial-refined-request',
    requestDigest: makeUserRequestDigest({
      inputRef: refinedRef,
      taskKind: 'meeting-minutes',
      eligibilityContext: context
    }),
    eligibilityContext: context
  })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'AGENT_INPUT_VERSION_UNAVAILABLE')
})

test('SEM-F28 / J24-B21 returns a complete refined snapshot in selected event order', (t) => {
  const clock = { value: 85000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, {
    sessionId: 'complete-refined-session',
    captions: ['synthetic original one', 'synthetic original two'],
    refinedCaptionIndexes: [1, 0]
  })

  const computed = client.service.requireAgentStore().readInput({
    sessionId: 'complete-refined-session',
    transcriptVersion: 'refined'
  })
  const snapshot = client.call(OPERATIONS.AGENT_READ_INPUT_SNAPSHOT, { inputRef: computed.inputRef })
  assert.deepEqual(snapshot.items.map((item) => item.eventOrder), [3, 4])
  assert.deepEqual(snapshot.items.map((item) => item.segmentId), ['segment-2', 'segment-1'])
  assert.equal(snapshot.inputRef.inputWatermark, 4)
  assert.deepEqual(snapshot.inputRef, computed.inputRef)
})

test('SEM-F26/SEM-F28 / J24-B06/B07/B10/B22 atomically commits artifacts and personal-memory facts', (t) => {
  const clock = { value: 90000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, {
    sessionId: 'result-session',
    captions: ['synthetic result one', 'synthetic result two']
  })
  client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'result-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })

  let minutesJob = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'result-claim-minutes', owner: 'result-worker', leaseMs: 5000, localWorkAllowed: false
  })
  const renewal = {
    runId: minutesJob.runId,
    lease: minutesJob.lease,
    newExpiresAt: clock.value + 6000
  }
  const renewed = client.call(OPERATIONS.AGENT_RENEW_JOB_LEASE, renewal)
  assert.deepEqual(client.call(OPERATIONS.AGENT_RENEW_JOB_LEASE, renewal), renewed)
  assert.equal(client.raw(OPERATIONS.AGENT_RENEW_JOB_LEASE, {
    ...renewal,
    lease: {
      owner: renewal.lease.owner,
      expiresAt: renewal.lease.expiresAt - 1
    }
  }).error.code, 'AGENT_JOB_STATE_CONFLICT')
  minutesJob = renewed
  const minutesArtifact = {
    type: 'meeting-minutes',
    content: {
      overview: 'Structured overview',
      conclusions: [{ text: 'A conclusion', evidence: [{ fromEventOrder: 1, throughEventOrder: 1 }] }],
      actionItems: [{
        text: 'An action', owner: null, due: null,
        evidence: [{ fromEventOrder: 2, throughEventOrder: 2 }]
      }],
      risks: []
    }
  }
  assert.equal(client.raw(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: minutesJob.runId,
    lease: minutesJob.lease,
    artifact: {
      ...minutesArtifact,
      content: {
        ...minutesArtifact.content,
        actionItems: [{
          ...minutesArtifact.content.actionItems[0],
          owner: 'invented owner'
        }]
      }
    }
  }).error.code, 'AGENT_OUTPUT_INVALID')
  const committedMinutes = client.call(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: minutesJob.runId, lease: minutesJob.lease, artifact: minutesArtifact
  })
  const replayedMinutes = client.call(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: minutesJob.runId, lease: minutesJob.lease, artifact: minutesArtifact
  })
  assert.equal(replayedMinutes.artifactId, committedMinutes.artifactId)
  assert.equal(client.raw(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: minutesJob.runId,
    lease: minutesJob.lease,
    artifact: { ...minutesArtifact, content: { ...minutesArtifact.content, overview: 'conflict' } }
  }).error.code, 'AGENT_OUTPUT_INVALID')

  const memoryJob = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'result-claim-memory', owner: 'result-worker', leaseMs: 5000, localWorkAllowed: false
  })
  const candidates = [
    {
      kind: 'decision',
      semanticKey: 'decision-one',
      scope: { kind: 'session', canonicalKey: 'result-session', label: 'Result session' },
      origin: 'explicit',
      content: { statement: 'A durable decision' },
      evidence: [{ fromEventOrder: 1, throughEventOrder: 2 }],
      confidenceBand: 'high',
      salienceBand: 'high'
    },
    {
      kind: 'experience',
      semanticKey: 'noise',
      scope: { kind: 'session', canonicalKey: 'result-session', label: 'Result session' },
      origin: 'automatic',
      content: { statement: 'noise' },
      evidence: [{ fromEventOrder: 1, throughEventOrder: 1 }],
      confidenceBand: 'high',
      salienceBand: 'low'
    },
    {
      kind: 'preference',
      semanticKey: 'unsupported-global-preference',
      scope: { kind: 'global', canonicalKey: 'global', label: 'Global' },
      origin: 'automatic',
      content: { statement: 'inferred preference' },
      evidence: [{ fromEventOrder: 2, throughEventOrder: 2 }],
      confidenceBand: 'high',
      salienceBand: 'high'
    }
  ]
  const committedMemory = client.call(OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES, {
    runId: memoryJob.runId, lease: memoryJob.lease, candidates
  })
  assert.deepEqual(committedMemory, {
    runId: memoryJob.runId,
    state: 'succeeded',
    acceptedCandidateCount: 1,
    discardedCandidateCount: 2,
    memoryItemCount: 1,
    evidenceCount: 1,
    revisionCount: 1
  })
  assert.deepEqual(client.call(OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES, {
    runId: memoryJob.runId, lease: memoryJob.lease, candidates
  }), committedMemory)

  const enhancedJob = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'result-claim-enhanced', owner: 'result-worker', leaseMs: 5000, localWorkAllowed: false
  })
  assert.equal(client.raw(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: enhancedJob.runId,
    lease: enhancedJob.lease,
    artifact: {
      type: 'enhanced-transcript',
      content: { paragraphs: [{ text: 'invalid range', evidence: [{ fromEventOrder: 999, throughEventOrder: 999 }] }] }
    }
  }).error.code, 'AGENT_OUTPUT_INVALID')
  const committedEnhanced = client.call(OPERATIONS.AGENT_COMMIT_ARTIFACT, {
    runId: enhancedJob.runId,
    lease: enhancedJob.lease,
    artifact: {
      type: 'enhanced-transcript',
      content: { paragraphs: [{ text: 'Enhanced paragraph', evidence: [{ fromEventOrder: 1, throughEventOrder: 2 }] }] }
    }
  })
  assert.equal(committedEnhanced.type, 'enhanced-transcript')

  const detail = client.call(OPERATIONS.AGENT_GET_SESSION_DETAIL, {
    sessionId: 'result-session', eligibilityContext: cloudContext()
  })
  assert.equal(detail.jobs.every((job) => !Object.hasOwn(job, 'lease') && !Object.hasOwn(job, 'cancelRequestedAt')), true)
  assert.equal(detail.jobs.every((job) => job.state === 'succeeded'), true)
  assert.equal(detail.artifacts.length, 2)
})

test('SEM-F28 / J24-B17 tombstones session deletion and rejects replayed or late work', (t) => {
  const clock = { value: 100000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, { sessionId: 'delete-session', captions: ['synthetic delete transcript'] })
  client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'delete-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  const running = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'delete-running-claim', owner: 'delete-worker', leaseMs: 5000, localWorkAllowed: false
  })
  const deleted = client.call(OPERATIONS.AGENT_DELETE_SESSION_DATA, {
    sessionId: 'delete-session', deletionIdempotencyKey: 'delete-action-1'
  })
  assert.equal(deleted.deletedJobCount, 3)
  assert.equal(deleted.deletedArtifactCount, 0)
  assert.deepEqual(client.call(OPERATIONS.AGENT_DELETE_SESSION_DATA, {
    sessionId: 'delete-session', deletionIdempotencyKey: 'delete-action-1'
  }), deleted)
  assert.equal(client.raw(OPERATIONS.AGENT_MARK_JOB_FAILED, {
    runId: running.runId, lease: running.lease, errorCode: 'AGENT_INTERNAL_FAILURE'
  }).error.code, 'AGENT_JOB_STATE_CONFLICT')
  assert.equal(client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'delete-running-claim', owner: 'delete-worker', leaseMs: 5000, localWorkAllowed: false
  }), null)
  assert.equal(client.raw(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'delete-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  }).error.code, 'AGENT_SESSION_NOT_FOUND')
  assert.equal(client.raw(
    OPERATIONS.OPEN_SESSION,
    { sessionId: 'delete-session', sourceId: 'loopback', startedAt: 101000, refinementEnabled: false },
    makeOpenSessionKey('delete-session')
  ).ok, false)
  assert.equal(client.service.store.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
