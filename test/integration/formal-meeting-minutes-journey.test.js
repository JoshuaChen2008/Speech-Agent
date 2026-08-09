'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentInputPlanner } = require('../../src/agent-core/formal/input-planner')
const { AgentJobRunner } = require('../../src/agent-core/formal/job-runner')
const { ModelGateway } = require('../../src/agent-core/formal/model-gateway')
const { AgentPluginHost } = require('../../src/agent-core/formal/plugin-host')
const { TranscriptReader } = require('../../src/agent-core/formal/storage-ports')
const { FormalAgentStore, makeUserRequestDigest } = require('../../src/runtime/storage-worker/formal-agent-store')
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

function environment () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-minutes-journey-'))
  return { root, databasePath: path.join(root, 'data', 'speech-agent.sqlite3') }
}

function journeyClient (t, clock) {
  const scope = environment()
  const client = workerClient(t, scope.databasePath, clock)
  t.after(() => fs.rmSync(scope.root, { recursive: true, force: true }))
  return client
}

function workerClient (t, databasePath, clock) {
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
      idFactory: () => `minutes-id-${String(++idState.value).padStart(6, '0')}`
    })
  })
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const request = {
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `minutes-request-${++sequence}`,
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
    commitAgentMemoryCandidates: async (input) => call(OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES, input)
  }
  return { call, service, storage }
}

function cloudContext () {
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
    localModelReady: false
  }
}

function createTerminalSession (client, {
  sessionId,
  sourceId = 'loopback',
  captions,
  refinedCaptionIndexes = []
}) {
  client.call(
    OPERATIONS.OPEN_SESSION,
    { sessionId, sourceId, startedAt: 100, refinementEnabled: refinedCaptionIndexes.length > 0 },
    makeOpenSessionKey(sessionId)
  )
  captions.forEach((text, index) => {
    const event = {
      schemaVersion: 1,
      sessionId,
      sourceId,
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
      sourceId,
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
  client.call(
    OPERATIONS.CLOSE_SESSION,
    { sessionId, sourceId, endedAt: 200, state: 'closed' },
    makeCloseSessionKey(sessionId)
  )
}

function prepareJobs (client, sessionId) {
  const reconciled = client.call(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, {
    sessionId,
    requestedBy: 'automatic',
    eligibilityContext: cloudContext()
  })
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: cloudContext() })
  return reconciled
}

function evidenceFromCandidates (candidates) {
  const ranges = candidates.flatMap((candidate) => [
    ...candidate.content.conclusions,
    ...candidate.content.actionItems,
    ...candidate.content.risks
  ].flatMap((item) => item.evidence))
  if (ranges.length === 0) return []
  return [{
    fromEventOrder: Math.min(...ranges.map((range) => range.fromEventOrder)),
    throughEventOrder: Math.max(...ranges.map((range) => range.throughEventOrder))
  }]
}

class DeterministicMinutesProvider {
  constructor (options = {}) {
    this.calls = []
    this.failMergeOnce = options.failMergeOnce === true
    this.failedMerge = false
    this.emptySections = options.emptySections === true
    this.invalidOwner = options.invalidOwner === true
    this.pending = options.pending === true
    this.limits = options.limits || { maxChunkInputBytes: 4096, maxResultBytes: 4096 }
    this.started = new Promise((resolve) => { this.resolveStarted = resolve })
  }

  async resolve (identity) {
    return {
      providerId: identity.providerId,
      providerKind: identity.providerKind,
      model: identity.model,
      ...this.limits,
      openModel: async (request) => this.openModel(request)
    }
  }

  output (request) {
    this.calls.push(structuredClone(request))
    this.resolveStarted()
    if (request.operation === 'meeting-minutes.merge') {
      const evidence = evidenceFromCandidates(request.input.candidates)
      return {
        type: 'meeting-minutes',
        content: {
          overview: 'merged overview',
          conclusions: evidence.length === 0 ? [] : [{ text: 'merged conclusion', evidence }],
          actionItems: [],
          risks: []
        }
      }
    }
    const first = request.input.segments[0].eventOrder
    const last = request.input.segments.at(-1).eventOrder
    const evidence = [{ fromEventOrder: first, throughEventOrder: last }]
    return {
      type: 'meeting-minutes',
      content: {
        overview: 'chunk overview',
        conclusions: this.emptySections ? [] : [{ text: 'chunk conclusion', evidence }],
        actionItems: this.invalidOwner
          ? [{ text: 'follow up', owner: 'invented owner', due: null, evidence }]
          : [],
        risks: []
      }
    }
  }

  async openModel (request) {
    const faux = await import('@earendil-works/pi-ai/providers/faux')
    let response
    if (this.pending) {
      this.calls.push(structuredClone(request))
      this.resolveStarted()
      response = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return faux.fauxAssistantMessage(JSON.stringify(this.output(request)))
      }
    } else if (request.operation === 'meeting-minutes.merge' && this.failMergeOnce && !this.failedMerge) {
      this.calls.push(structuredClone(request))
      this.resolveStarted()
      this.failedMerge = true
      response = faux.fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'HTTP 408 request timeout'
      })
    } else {
      response = faux.fauxAssistantMessage(JSON.stringify(this.output(request)))
    }
    const core = faux.createFauxCore({
      provider: 'deterministic-test',
      api: 'formal-minutes-test',
      models: [{ id: 'fixture-model' }]
    })
    core.setResponses([response])
    return { model: core.getModel(), apiKey: undefined, streamFn: core.streamSimple }
  }
}

function runtime (client, provider, clock, options = {}) {
  const modelGateway = new ModelGateway({
    providerAdapter: provider,
    timeoutMs: options.modelTimeoutMs || 5000
  })
  const host = new AgentPluginHost({
    transcriptReader: new TranscriptReader(client.storage),
    inputPlanner: new AgentInputPlanner(),
    modelGateway,
    disabledPluginIds: ['enhanced-transcript', 'memory-consolidation', 'memory-extraction'],
    timeoutMs: options.timeoutMs
  })
  const runner = new AgentJobRunner({
    storage: client.storage,
    pluginHost: host,
    owner: 'minutes-runner',
    leaseMs: 120000,
    retryDelaysMs: [0],
    now: () => clock.value
  })
  return { host, runner }
}

test('SEM-F15/F16/F28 / J24-B02/B19/B20/B29 runs real ModelGateway/Pi minutes and leaves unavailable tasks queued', async (t) => {
  const clock = { value: 10000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, { sessionId: 'short-session', captions: ['synthetic short input'] })
  const reconciled = prepareJobs(client, 'short-session')
  const inputRef = reconciled.inputRef

  const snapshot = await client.storage.readAgentInputSnapshot({ inputRef })
  assert.deepEqual(snapshot.inputRef, inputRef)
  await assert.rejects(
    client.storage.readAgentInputSnapshot({ inputRef: { ...inputRef, inputDigest: 'f'.repeat(64) } }),
    (error) => error.code === 'AGENT_INPUT_CHANGED'
  )

  const provider = new DeterministicMinutesProvider({ emptySections: true })
  const { runner } = runtime(client, provider, clock)
  const result = await runner.runNext({ claimIdempotencyKey: 'short-claim', localWorkAllowed: false })
  assert.equal(result.jobState, 'succeeded')
  assert.deepEqual(result.artifact.content, {
    overview: 'chunk overview', conclusions: [], actionItems: [], risks: []
  })
  assert.equal(await runner.runNext({ claimIdempotencyKey: 'short-no-compatible-task', localWorkAllowed: false }), null)
  assert.throws(() => client.call(OPERATIONS.AGENT_CLAIM_NEXT_JOB, {
    claimIdempotencyKey: 'short-no-compatible-task',
    owner: 'minutes-runner',
    leaseMs: 120000,
    localWorkAllowed: false,
    availableTaskKinds: ['memory-extraction']
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')

  const detail = client.call(OPERATIONS.AGENT_GET_SESSION_DETAIL, {
    sessionId: 'short-session', eligibilityContext: cloudContext()
  })
  assert.equal(detail.jobs.find((job) => job.taskKind === 'meeting-minutes').state, 'succeeded')
  assert.equal(detail.jobs.filter((job) => job.taskKind !== 'meeting-minutes').every((job) => job.state === 'queued'), true)
  assert.equal(detail.artifacts.length, 1)
  assert.equal(client.call(OPERATIONS.GET_SESSION, { sessionId: 'short-session' }).segments.length, 1)
})

test('SEM-F15/F28 / J24-B21 runs one complete refined snapshot in selected event order', async (t) => {
  const clock = { value: 15000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, {
    sessionId: 'refined-session',
    captions: ['synthetic original one', 'synthetic original two'],
    refinedCaptionIndexes: [1, 0]
  })
  const refinedSnapshot = client.service.requireAgentStore().readInput({
    sessionId: 'refined-session',
    transcriptVersion: 'refined'
  })
  const context = cloudContext()
  const request = {
    inputRef: refinedSnapshot.inputRef,
    taskKind: 'meeting-minutes',
    clientIdempotencyKey: 'refined-minutes-request',
    requestDigest: makeUserRequestDigest({
      inputRef: refinedSnapshot.inputRef,
      taskKind: 'meeting-minutes',
      eligibilityContext: context
    }),
    eligibilityContext: context
  }
  assert.equal(client.call(OPERATIONS.AGENT_REQUEST_JOB, request).status, 'created')
  client.call(OPERATIONS.AGENT_APPLY_TASK_POLICY, { eligibilityContext: context })

  const provider = new DeterministicMinutesProvider()
  const { runner } = runtime(client, provider, clock)
  const result = await runner.runNext({ claimIdempotencyKey: 'refined-claim', localWorkAllowed: false })
  assert.equal(result.jobState, 'succeeded')
  assert.deepEqual(
    provider.calls.filter((call) => call.operation === 'meeting-minutes.chunk')
      .flatMap((call) => call.input.segments.map((segment) => segment.eventOrder)),
    [3, 4]
  )
  assert.equal(result.artifact.inputRef.transcriptVersion, 'refined')
  assert.deepEqual(result.artifact.inputRef, refinedSnapshot.inputRef)
})

test('SEM-F28 / J24-B03/B06/B27/B28 retries one long frozen input without partial artifacts', async (t) => {
  const clock = { value: 20000 }
  const client = journeyClient(t, clock)
  const longText = '😀甲'.repeat(800)
  createTerminalSession(client, { sessionId: 'long-session', captions: [longText] })
  const reconciled = prepareJobs(client, 'long-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({
    failMergeOnce: true,
    limits: { maxChunkInputBytes: 1200, maxResultBytes: 400 }
  })
  const { runner } = runtime(client, provider, clock)
  const first = await runner.runNext({ claimIdempotencyKey: 'long-claim-1', localWorkAllowed: false })
  assert.equal(first.runId, runId)
  assert.equal(first.jobState, 'retry_wait')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)

  const firstAttemptChunks = provider.calls
    .slice(0, provider.calls.findIndex((call) => call.operation === 'meeting-minutes.merge'))
    .flatMap((call) => call.input.segments.map((segment) => segment.text))
  assert.equal(firstAttemptChunks.join(''), longText)
  assert.equal(firstAttemptChunks.length > 1, true)
  assert.equal(firstAttemptChunks.every((text) => Array.from(text).join('') === text), true)

  const second = await runner.runNext({ claimIdempotencyKey: 'long-claim-2', localWorkAllowed: false })
  assert.equal(second.runId, runId)
  assert.equal(second.jobState, 'succeeded')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 1)
  const row = client.service.store.database.prepare('SELECT attempt_count, state FROM agent_jobs WHERE run_id = ?').get(runId)
  assert.equal(row.attempt_count, 2)
  assert.equal(row.state, 'succeeded')
})

test('SEM-F09/F28 / J24-B10 cancels a running minutes job and rejects its late result', async (t) => {
  const clock = { value: 30000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, { sessionId: 'cancel-session', captions: ['synthetic cancellation input'] })
  const reconciled = prepareJobs(client, 'cancel-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({ pending: true })
  const { runner } = runtime(client, provider, clock)
  const running = runner.runNext({ claimIdempotencyKey: 'cancel-claim', localWorkAllowed: false })
  await provider.started
  const requested = await runner.cancel(runId)
  assert.equal(requested.state, 'running')
  const settled = await running
  assert.equal(settled.jobState, 'cancelled')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  assert.equal(client.service.store.database.prepare('SELECT state FROM agent_jobs WHERE run_id = ?').get(runId).state, 'cancelled')
})

test('SEM-F09/F15 / J24-B12 rejects an invalid structured result without changing subtitle facts', async (t) => {
  const clock = { value: 40000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, { sessionId: 'invalid-output-session', sourceId: 'mic', captions: ['synthetic ownerless input'] })
  const reconciled = prepareJobs(client, 'invalid-output-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({ invalidOwner: true })
  const { runner } = runtime(client, provider, clock)
  const result = await runner.runNext({ claimIdempotencyKey: 'invalid-output-claim', localWorkAllowed: false })
  assert.equal(result.jobState, 'failed')
  const jobRow = client.service.store.database.prepare(
    'SELECT state, error_code FROM agent_jobs WHERE run_id = ?'
  ).get(runId)
  assert.equal(jobRow.state, 'failed')
  assert.equal(jobRow.error_code, 'AGENT_OUTPUT_INVALID')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  assert.equal(client.call(OPERATIONS.GET_SESSION, { sessionId: 'invalid-output-session' }).segments.length, 1)
})
