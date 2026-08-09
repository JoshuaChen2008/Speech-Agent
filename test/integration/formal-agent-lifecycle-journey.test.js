'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')

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

test('SEM-F26/SEM-F28 / J24-B14 cancels only personal-memory work and never revives it implicitly', (t) => {
  const clock = { value: 45000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  createSession(client, { sessionId: 'memory-policy-session', captions: ['synthetic memory policy transcript'] })
  const reconciled = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-policy-session', requestedBy: 'automatic', eligibilityContext: cloudContext()
  })
  assert.equal(reconciled.jobs.length, 3)
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })

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

  assert.deepEqual(client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: cloudContext({ memoryEnabled: false })
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

  const replay = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-policy-session',
    requestedBy: 'automatic',
    eligibilityContext: cloudContext({ memoryEnabled: false })
  })
  assert.deepEqual(replay.jobs.map((entry) => entry.job.taskKind), ['meeting-minutes', 'enhanced-transcript'])
  assert.equal(client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: cloudContext()
  }).queuedCancelled, 0)
  const memoryRow = client.service.store.database.prepare(
    "SELECT state FROM agent_jobs WHERE session_id = ? AND plugin_id = 'memory-extraction'"
  ).get('memory-policy-session')
  assert.equal(memoryRow.state, 'cancelled')

  const enhanced = client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'policy-claim-enhanced',
    owner: 'policy-worker', leaseMs: 1000, localWorkAllowed: false
  })
  assert.equal(enhanced.taskKind, 'enhanced-transcript')
  assert.deepEqual(client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, {
    eligibilityContext: cloudContext({ agentEnabled: false })
  }), { queuedCancelled: 0, runningCancellationRequested: 1 })
  assert.equal(client.call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, {
    runId: enhanced.runId,
    lease: enhanced.lease
  }).state, 'cancelled')
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

test('SEM-F26/SEM-F28 / J24-B14 applies the new personal-memory automatic processing boundary', (t) => {
  const clock = { value: 70000 }
  const environment = journeyEnvironment(t)
  const client = environment.track(serviceFor(environment.databasePath, clock, { value: 0 }))
  const disabled = cloudContext({ memoryEnabled: false })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: disabled })
  createSession(client, {
    sessionId: 'memory-disabled-period', captions: ['synthetic disabled-period transcript'],
    startedAt: 300, endedAt: 350
  })

  const reenabled = cloudContext({ memoryProcessingSince: 400 })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: reenabled })
  const oldSession = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-disabled-period', requestedBy: 'automatic', eligibilityContext: reenabled
  })
  assert.deepEqual(oldSession.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'enhanced-transcript'
  ])

  createSession(client, {
    sessionId: 'memory-after-reenable', captions: ['synthetic post-boundary transcript'],
    startedAt: 401, endedAt: 450
  })
  const newSession = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId: 'memory-after-reenable', requestedBy: 'automatic', eligibilityContext: reenabled
  })
  assert.deepEqual(newSession.jobs.map((entry) => entry.job.taskKind), [
    'meeting-minutes', 'memory-extraction', 'enhanced-transcript'
  ])
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
