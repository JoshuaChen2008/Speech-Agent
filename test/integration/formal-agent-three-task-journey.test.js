'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { canonicalBytes } = require('../../src/agent-core/formal/contracts')
const { AgentInputPlanner } = require('../../src/agent-core/formal/input-planner')
const { AgentJobRunner } = require('../../src/agent-core/formal/job-runner')
const { ModelGateway } = require('../../src/agent-core/formal/model-gateway')
const { AgentPluginHost } = require('../../src/agent-core/formal/plugin-host')
const { MemoryReader, TranscriptReader } = require('../../src/agent-core/formal/storage-ports')
const {
  FormalAgentStore,
  makeUserRequestDigest
} = require('../../src/runtime/storage-worker/formal-agent-store')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function cloudContext (overrides = {}) {
  return {
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
}

function journeyClient (t, clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-three-task-'))
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const idState = { value: 0 }
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore({
      ...options,
      migrations: FORMAL_AGENT_MIGRATIONS,
      now: () => clock.value
    }),
    agentStoreFactory: (subtitleStore) => new FormalAgentStore({
      subtitleStore,
      now: () => clock.value,
      idFactory: () => `three-task-id-${String(++idState.value).padStart(6, '0')}`
    })
  })
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const request = {
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `three-task-request-${++sequence}`,
      operation,
      payload
    }
    if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey
    const response = service.handle(request)
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.code = response.error.code
      throw error
    }
    return response.result
  }
  call(OPERATIONS.INITIALIZE, { databasePath })
  t.after(() => {
    if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    fs.rmSync(root, { recursive: true, force: true })
  })
  const storage = {
    readAgentInputSnapshot: async (input) => call(OPERATIONS.AGENT_READ_INPUT_SNAPSHOT, input),
    claimNextAgentJob: async (input) => call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, input),
    renewAgentJobLease: async (input) => call(OPERATIONS.AGENT_RENEW_JOB_LEASE, input),
    markAgentJobRetry: async (input) => call(OPERATIONS.AGENT_MARK_JOB_RETRY, input),
    markAgentJobFailed: async (input) => call(OPERATIONS.AGENT_MARK_JOB_FAILED, input),
    requestAgentCancel: async (input) => call(OPERATIONS.AGENT_REQUEST_CANCEL, input),
    markAgentJobCancelled: async (input) => call(OPERATIONS.AGENT_MARK_JOB_CANCELLED, input),
    commitAgentArtifact: async (input) => call(OPERATIONS.AGENT_COMMIT_ARTIFACT, input),
    commitAgentMemoryCandidates: async (input) => call(OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES, input),
    readAgentMemoryContext: async (input) => call(OPERATIONS.AGENT_READ_MEMORY_CONTEXT, input)
  }
  return { call, service, storage }
}

function createTerminalSession (client, sessionId, captions) {
  client.call(
    OPERATIONS.OPEN_SESSION,
    { sessionId, sourceId: 'loopback', startedAt: 100, refinementEnabled: false },
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
  client.call(
    OPERATIONS.CLOSE_SESSION,
    { sessionId, sourceId: 'loopback', endedAt: 200, state: 'closed' },
    makeCloseSessionKey(sessionId)
  )
  const reconciled = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId,
    requestedBy: 'automatic',
    eligibilityContext: cloudContext()
  })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  return reconciled
}

function eventRangeFromSegments (segments) {
  return [{
    fromEventOrder: Math.min(...segments.map((segment) => segment.eventOrder)),
    throughEventOrder: Math.max(...segments.map((segment) => segment.eventOrder))
  }]
}

function eventRangeFromArtifacts (artifacts) {
  const ranges = artifacts.flatMap((artifact) => artifact.content.paragraphs)
    .flatMap((paragraph) => paragraph.evidence)
  return [{
    fromEventOrder: Math.min(...ranges.map((range) => range.fromEventOrder)),
    throughEventOrder: Math.max(...ranges.map((range) => range.throughEventOrder))
  }]
}

function memoryCandidates (sessionId, segments) {
  const first = segments[0].eventOrder
  const last = segments.at(-1).eventOrder
  const evidence = (eventOrder) => [{ fromEventOrder: eventOrder, throughEventOrder: eventOrder }]
  return [
    {
      kind: 'decision', semanticKey: 'decision:release',
      scope: { kind: 'session', canonicalKey: sessionId, label: 'fixture session' },
      origin: 'explicit', content: { statement: 'synthetic explicit decision' }, evidence: evidence(first),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'term', semanticKey: 'term:fixture',
      scope: { kind: 'session', canonicalKey: sessionId, label: 'fixture session' },
      origin: 'explicit', content: { canonical: 'fixture term' }, evidence: evidence(first),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'term', semanticKey: 'term:fixture',
      scope: { kind: 'session', canonicalKey: sessionId, label: 'fixture session' },
      origin: 'explicit', content: { canonical: 'fixture term' }, evidence: evidence(last),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'project-fact', semanticKey: 'project:phase',
      scope: { kind: 'project', canonicalKey: 'project:fixture', label: 'fixture project' },
      origin: 'automatic', content: { phase: 'alpha' }, evidence: evidence(first),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'project-fact', semanticKey: 'project:phase',
      scope: { kind: 'project', canonicalKey: 'project:fixture', label: 'fixture project' },
      origin: 'automatic', content: { phase: 'beta' }, evidence: evidence(last),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'experience', semanticKey: 'noise:fixture',
      scope: { kind: 'session', canonicalKey: sessionId, label: 'fixture session' },
      origin: 'automatic', content: { note: 'synthetic noise' }, evidence: evidence(first),
      confidenceBand: 'high', salienceBand: 'low'
    },
    {
      kind: 'conclusion', semanticKey: 'noise:low-confidence',
      scope: { kind: 'session', canonicalKey: sessionId, label: 'fixture session' },
      origin: 'automatic', content: { note: 'synthetic low confidence inference' }, evidence: evidence(last),
      confidenceBand: 'low', salienceBand: 'medium'
    },
    {
      kind: 'preference', semanticKey: 'preference:global',
      scope: { kind: 'global', canonicalKey: 'global:user', label: 'global' },
      origin: 'automatic', content: { preference: 'synthetic inferred preference' }, evidence: evidence(first),
      confidenceBand: 'high', salienceBand: 'high'
    },
    {
      kind: 'preference', semanticKey: 'preference:global-explicit',
      scope: { kind: 'global', canonicalKey: 'global:user', label: 'global' },
      origin: 'explicit', content: { preference: 'synthetic explicit but unattributed preference' }, evidence: evidence(last),
      confidenceBand: 'high', salienceBand: 'high'
    }
  ]
}

class DeterministicThreeTaskProvider {
  constructor (options = {}) {
    this.calls = []
    this.identities = []
    this.invalidMemory = options.invalidMemory === true
    this.failEnhancedMergeOnce = options.failEnhancedMergeOnce === true
    this.enhancedMergeFailed = false
    this.limits = options.limits || { maxChunkInputBytes: 4096, maxResultBytes: 4096 }
  }

  async resolve (identity) {
    this.identities.push(structuredClone(identity))
    return {
      providerId: identity.providerId,
      providerKind: identity.providerKind,
      model: identity.model,
      ...this.limits,
      openModel: async (request) => this.openModel(request)
    }
  }

  output (request) {
    if (request.operation === 'meeting-minutes.chunk') {
      return {
        type: 'meeting-minutes',
        content: { overview: 'fixture overview', conclusions: [], actionItems: [], risks: [] }
      }
    }
    if (request.operation === 'meeting-minutes.merge') {
      return {
        type: 'meeting-minutes',
        content: { overview: 'fixture merged overview', conclusions: [], actionItems: [], risks: [] }
      }
    }
    if (request.operation === 'memory-extraction.chunk') {
      if (this.invalidMemory) {
        return {
          type: 'memory-candidates',
          candidates: [{
            kind: 'decision', semanticKey: 'invalid',
            scope: { kind: 'session', canonicalKey: request.input.inputRef.sessionId, label: 'fixture' },
            origin: 'explicit', content: {}, evidence: eventRangeFromSegments(request.input.segments),
            confidenceBand: 'high'
          }]
        }
      }
      return {
        type: 'memory-candidates',
        candidates: memoryCandidates(request.input.inputRef.sessionId, request.input.segments)
      }
    }
    if (request.operation === 'enhanced-transcript.chunk') {
      return {
        type: 'enhanced-transcript',
        content: {
          paragraphs: [{ text: `enhanced chunk ${request.input.chunkIndex}`, evidence: eventRangeFromSegments(request.input.segments) }]
        }
      }
    }
    if (request.operation === 'enhanced-transcript.merge') {
      return {
        type: 'enhanced-transcript',
        content: {
          paragraphs: [{ text: 'enhanced merged transcript', evidence: eventRangeFromArtifacts(request.input.candidates) }]
        }
      }
    }
    throw new Error('unexpected operation')
  }

  async openModel (request) {
    const faux = await import('@earendil-works/pi-ai/providers/faux')
    this.calls.push(structuredClone(request))
    let response
    if (request.operation === 'enhanced-transcript.merge' &&
        this.failEnhancedMergeOnce && !this.enhancedMergeFailed) {
      this.enhancedMergeFailed = true
      response = faux.fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'HTTP 408 request timeout'
      })
    } else {
      response = faux.fauxAssistantMessage(JSON.stringify(this.output(request)))
    }
    const core = faux.createFauxCore({
      provider: 'deterministic-test',
      api: 'formal-three-task-test',
      models: [{ id: 'fixture-model' }]
    })
    core.setResponses([response])
    return { model: core.getModel(), apiKey: undefined, streamFn: core.streamSimple }
  }
}

function runtime (client, provider, clock, disabledPluginIds = []) {
  const modelGateway = new ModelGateway({ providerAdapter: provider, timeoutMs: 5000 })
  const host = new AgentPluginHost({
    transcriptReader: new TranscriptReader(client.storage),
    inputPlanner: new AgentInputPlanner(),
    modelGateway,
    disabledPluginIds
  })
  const runner = new AgentJobRunner({
    storage: client.storage,
    pluginHost: host,
    owner: 'three-task-runner',
    leaseMs: 120000,
    retryDelaysMs: [0],
    now: () => clock.value
  })
  return { host, runner }
}

test('SEM-F13/F16/F26/F28 / J13/J21/J24-B22/B25/B31 runs three independent tasks from one frozen transcript', async (t) => {
  const clock = { value: 10000 }
  const client = journeyClient(t, clock)
  const reconciled = createTerminalSession(client, 'three-task-session', [
    'synthetic decision input',
    'synthetic project phase input'
  ])
  const provider = new DeterministicThreeTaskProvider()
  const { runner } = runtime(client, provider, clock)

  const minutes = await runner.runNext({ claimIdempotencyKey: 'three-task-claim-1', localWorkAllowed: false })
  const memory = await runner.runNext({ claimIdempotencyKey: 'three-task-claim-2', localWorkAllowed: false })
  const enhanced = await runner.runNext({ claimIdempotencyKey: 'three-task-claim-3', localWorkAllowed: false })

  assert.equal(minutes.artifact.type, 'meeting-minutes')
  assert.equal(memory.artifact, null)
  assert.deepEqual(memory.memory, {
    runId: memory.runId,
    state: 'succeeded',
    acceptedCandidateCount: 5,
    discardedCandidateCount: 4,
    memoryItemCount: 3,
    evidenceCount: 5,
    revisionCount: 4
  })
  assert.equal(enhanced.artifact.type, 'enhanced-transcript')
  assert.equal(await runner.runNext({ claimIdempotencyKey: 'three-task-claim-empty', localWorkAllowed: false }), null)

  assert.deepEqual(provider.identities.map((identity) => identity.recipeVersion), [
    'meeting-minutes@1', 'memory-extraction@1', 'enhanced-transcript@1'
  ])
  assert.equal(provider.calls.every((call) =>
    JSON.stringify(call.input.inputRef) === JSON.stringify(reconciled.inputRef)
  ), true)
  const memoryCall = provider.calls.find((call) => call.operation === 'memory-extraction.chunk')
  assert.equal(Array.isArray(memoryCall.input.segments), true)
  assert.equal(Object.hasOwn(memoryCall.input, 'candidates'), false)
  assert.equal(Object.hasOwn(memoryCall.input.segments[0], 'sourceId'), false)
  assert.equal(Object.hasOwn(memoryCall.input.segments[0], 'segmentId'), false)

  const database = client.service.store.database
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 2)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 3)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_evidence').get().count, 5)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get().count, 4)
  assert.equal(database.prepare(
    "SELECT lifecycle FROM memory_items WHERE semantic_key = 'project:phase'"
  ).get().lifecycle, 'conflicted')
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM memory_items WHERE kind = 'preference'"
  ).get().count, 0)
  assert.equal(database.prepare(
    'SELECT COUNT(DISTINCT input_digest) AS count FROM agent_jobs'
  ).get().count, 1)
})

test('SEM-F09/F28 / J24-B12/B25 keeps minutes and enhanced transcript independent from invalid memory output', async (t) => {
  const clock = { value: 20000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, 'independent-failure-session', [
    'synthetic first input',
    'synthetic second input'
  ])
  const provider = new DeterministicThreeTaskProvider({ invalidMemory: true })
  const { runner } = runtime(client, provider, clock)

  assert.equal((await runner.runNext({ claimIdempotencyKey: 'independent-claim-1', localWorkAllowed: false })).jobState, 'succeeded')
  const failedMemory = await runner.runNext({ claimIdempotencyKey: 'independent-claim-2', localWorkAllowed: false })
  assert.equal(failedMemory.jobState, 'failed')
  assert.equal((await runner.runNext({ claimIdempotencyKey: 'independent-claim-3', localWorkAllowed: false })).jobState, 'succeeded')

  const database = client.service.store.database
  const jobStates = database.prepare(
    'SELECT plugin_id AS taskKind, state FROM agent_jobs ORDER BY job_order'
  ).all().map((row) => ({ taskKind: row.taskKind, state: row.state }))
  assert.deepEqual(jobStates, [
    { taskKind: 'meeting-minutes', state: 'succeeded' },
    { taskKind: 'memory-extraction', state: 'failed' },
    { taskKind: 'enhanced-transcript', state: 'succeeded' }
  ])
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 2)
  assert.equal(client.call(OPERATIONS.GET_SESSION, { sessionId: 'independent-failure-session' }).segments.length, 2)
})

test('SEM-F13/F28 / J24-B03/B28 retries enhanced merge without a partial artifact', async (t) => {
  const clock = { value: 30000 }
  const client = journeyClient(t, clock)
  const longText = '😀增强'.repeat(800)
  const reconciled = createTerminalSession(client, 'enhanced-long-session', [longText])
  const provider = new DeterministicThreeTaskProvider({
    failEnhancedMergeOnce: true,
    limits: { maxChunkInputBytes: 1200, maxResultBytes: 400 }
  })
  const { runner } = runtime(client, provider, clock, [
    'meeting-minutes', 'memory-consolidation', 'memory-extraction'
  ])
  const enhancedRunId = reconciled.jobs.find((entry) =>
    entry.job.taskKind === 'enhanced-transcript'
  ).job.runId

  const first = await runner.runNext({ claimIdempotencyKey: 'enhanced-long-claim-1', localWorkAllowed: false })
  assert.equal(first.runId, enhancedRunId)
  assert.equal(first.jobState, 'retry_wait')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)

  const firstMergeIndex = provider.calls.findIndex((call) => call.operation === 'enhanced-transcript.merge')
  const firstAttemptText = provider.calls.slice(0, firstMergeIndex)
    .flatMap((call) => call.input.segments.map((segment) => segment.text))
    .join('')
  assert.equal(firstAttemptText, longText)

  const second = await runner.runNext({ claimIdempotencyKey: 'enhanced-long-claim-2', localWorkAllowed: false })
  assert.equal(second.runId, enhancedRunId)
  assert.equal(second.jobState, 'succeeded')
  assert.equal(second.artifact.type, 'enhanced-transcript')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 1)
  assert.equal(client.service.store.database.prepare(
    "SELECT COUNT(*) AS count FROM agent_jobs WHERE state = 'queued'"
  ).get().count, 2)
})

test('SEM-F26 / D8/J24-B14/B22 storage-worker sub-boundary reads bounded current memory and preserves its dormant projection', async (t) => {
  const clock = { value: 40000 }
  const client = journeyClient(t, clock)
  const sessionId = 'bounded-memory-session'
  createTerminalSession(client, sessionId, [
    'synthetic decision input',
    'synthetic project phase input'
  ])
  const provider = new DeterministicThreeTaskProvider()
  const { runner } = runtime(client, provider, clock, ['meeting-minutes', 'enhanced-transcript'])
  assert.equal((await runner.runNext({
    claimIdempotencyKey: 'bounded-memory-claim',
    localWorkAllowed: false
  })).jobState, 'succeeded')

  const reader = new MemoryReader(client.storage)
  const query = {
    scopeRefs: [
      { kind: 'session', canonicalKey: sessionId },
      { kind: 'project', canonicalKey: 'project:fixture' }
    ],
    kinds: ['decision', 'term', 'project-fact'],
    semanticKeys: [],
    maxItems: 20,
    maxSerializedBytes: 65536
  }
  const active = await reader.query(query)
  assert.equal(active.availability, 'ready')
  assert.equal(active.reason, null)
  assert.deepEqual(active.items.map((item) => item.semanticKey), [
    'term:fixture',
    'decision:release'
  ])
  assert.equal(active.items.some((item) => item.semanticKey === 'project:phase'), false)
  assert.deepEqual(active.items.map((item) => item.evidenceCount), [2, 1])
  assert.equal(active.items.every((item) => item.evidence.length === item.evidenceCount), true)
  assert.equal(active.serializedBytes, active.items.reduce(
    (total, item) => total + canonicalBytes(item),
    0
  ))
  assert.equal(active.hasMore, false)

  const termBytes = canonicalBytes(active.items[0])
  assert.equal(termBytes > 256, true)
  const termOnly = { ...query, semanticKeys: ['term:fixture'] }
  const tooSmall = await reader.query({ ...termOnly, maxSerializedBytes: termBytes - 1 })
  assert.deepEqual(tooSmall.items, [])
  assert.equal(tooSmall.serializedBytes, 0)
  assert.equal(tooSmall.hasMore, true)
  const exactFit = await reader.query({ ...termOnly, maxSerializedBytes: termBytes })
  assert.equal(exactFit.items.length, 1)
  assert.equal(exactFit.serializedBytes, termBytes)
  const oneItem = await reader.query({ ...query, maxItems: 1 })
  assert.deepEqual(oneItem.items.map((item) => item.semanticKey), ['term:fixture'])
  assert.equal(oneItem.hasMore, true)

  const database = client.service.store.database
  const memoryFacts = () => ({
    items: database.prepare('SELECT * FROM memory_items ORDER BY memory_id').all(),
    revisions: database.prepare('SELECT * FROM memory_revisions ORDER BY revision_id').all(),
    evidence: database.prepare('SELECT * FROM memory_evidence ORDER BY evidence_id').all()
  })
  const beforeDormant = memoryFacts()
  const dormantCases = [
    ['agent_disabled', cloudContext({
      agentEnabled: false,
      automaticProcessingSince: null,
      memoryProcessingSince: null
    })],
    ['memory_disabled', cloudContext({
      memoryEnabled: false,
      memoryProcessingSince: null
    })],
    ['provider_not_configured', cloudContext({
      providerId: null,
      providerKind: null,
      model: null
    })],
    ['cloud_disclosure_required', cloudContext({ cloudDisclosureAccepted: false })],
    ['credential_unavailable', cloudContext({ credentialAvailable: false })],
    ['local_model_not_ready', cloudContext({
      providerId: 'local-primary',
      providerKind: 'local',
      model: 'local-model',
      cloudDisclosureAccepted: false,
      credentialAvailable: false,
      localModelReady: false
    })]
  ]
  for (const [reason, eligibilityContext] of dormantCases) {
    client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext })
    const dormant = await reader.query(query)
    assert.deepEqual(dormant, {
      availability: 'dormant',
      reason,
      items: [],
      itemCount: 0,
      serializedBytes: 0,
      hasMore: false
    })
    assert.deepEqual(memoryFacts(), beforeDormant)
  }

  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  assert.deepEqual(
    (await reader.query(query)).items.map((item) => item.semanticKey),
    active.items.map((item) => item.semanticKey)
  )
  assert.deepEqual(memoryFacts(), beforeDormant)

  client.service.agentStore = null
  await assert.rejects(reader.query(query), (error) => error.code === 'AGENT_REQUEST_INVALID')
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  assert.equal((await reader.query(query)).availability, 'ready')

  await assert.rejects(reader.query({
    ...query,
    scopeRefs: [query.scopeRefs[0], query.scopeRefs[0]]
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')

  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare(`
      UPDATE memory_items SET content_json = '{"tampered":true}'
      WHERE semantic_key = 'term:fixture'
    `).run()
    await assert.rejects(reader.query(termOnly), (error) => error.code === 'STORAGE_COMMAND_FAILED')
  } finally {
    database.exec('ROLLBACK')
  }
})

test('SEM-F26 / J21/J24-B22 deletes one memory with multi-source suppression and idempotent replay', async (t) => {
  const clock = { value: 50000 }
  const client = journeyClient(t, clock)
  const firstSessionId = 'suppressed-memory-session-a'
  const first = createTerminalSession(client, firstSessionId, [
    'synthetic decision input',
    'synthetic project phase input'
  ])
  const provider = new DeterministicThreeTaskProvider()
  const { runner } = runtime(client, provider, clock, ['meeting-minutes', 'enhanced-transcript'])
  assert.equal((await runner.runNext({
    claimIdempotencyKey: 'suppressed-memory-claim-a',
    localWorkAllowed: false
  })).jobState, 'succeeded')

  const secondSessionId = 'suppressed-memory-session-b'
  createTerminalSession(client, secondSessionId, [
    'synthetic second-session decision input',
    'synthetic second-session project phase input'
  ])
  assert.equal((await runner.runNext({
    claimIdempotencyKey: 'suppressed-memory-claim-b',
    localWorkAllowed: false
  })).jobState, 'succeeded')

  const database = client.service.store.database
  const projectMemory = database.prepare(`
    SELECT memory_id FROM memory_items WHERE semantic_key = 'project:phase'
  `).get()
  assert.ok(projectMemory)
  assert.equal(database.prepare(`
    SELECT COUNT(DISTINCT input_digest) AS count
    FROM memory_evidence WHERE memory_id = ?
  `).get(projectMemory.memory_id).count, 2)

  const deletion = client.call(OPERATIONS.AGENT_DELETE_MEMORY_ITEM, {
    memoryId: projectMemory.memory_id,
    deletionIdempotencyKey: 'delete-project-memory'
  })
  assert.deepEqual(deletion, {
    memoryId: projectMemory.memory_id,
    suppressedSourceCount: 2,
    deletedEvidenceCount: 4,
    deletedRevisionCount: 4,
    deletedAt: clock.value
  })
  assert.deepEqual(client.call(OPERATIONS.AGENT_DELETE_MEMORY_ITEM, {
    memoryId: projectMemory.memory_id,
    deletionIdempotencyKey: 'delete-project-memory'
  }), deletion)
  assert.throws(() => client.call(OPERATIONS.AGENT_DELETE_MEMORY_ITEM, {
    memoryId: 'different-memory-id',
    deletionIdempotencyKey: 'delete-project-memory'
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM memory_items WHERE semantic_key = 'project:phase'"
  ).get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_suppressions').get().count, 2)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_deletion_receipts').get().count, 1)

  const request = {
    inputRef: first.inputRef,
    taskKind: 'memory-extraction',
    clientIdempotencyKey: 'rescan-deleted-project-memory',
    requestDigest: makeUserRequestDigest({
      inputRef: first.inputRef,
      taskKind: 'memory-extraction',
      eligibilityContext: cloudContext()
    }),
    eligibilityContext: cloudContext()
  }
  assert.equal(client.call(OPERATIONS.AGENT_REQUEST_JOB, request).status, 'created')
  const rescan = await runner.runNext({
    claimIdempotencyKey: 'suppressed-memory-rescan-claim',
    localWorkAllowed: false
  })
  assert.equal(rescan.jobState, 'succeeded')
  assert.equal(rescan.memory.acceptedCandidateCount, 3)
  assert.equal(rescan.memory.discardedCandidateCount, 6)
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM memory_items WHERE semantic_key = 'project:phase'"
  ).get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_suppressions').get().count, 2)
})
