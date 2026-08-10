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
const { AgentModelProviderRegistry } = require('../../src/agent-provider/model-provider-registry')
const {
  AgentProviderBootstrap,
  CREDENTIAL_ENV_NAME,
  DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG
} = require('../../src/agent-provider/provider-bootstrap')
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
    providerId: 'deepseek',
    providerKind: 'cloud',
    model: 'deepseek-v4-flash',
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
    this.authFailure = options.authFailure === true
    this.extraHandleFieldOnce = options.extraHandleFieldOnce === true
    this.extraHandleFieldReturned = false
    this.limits = options.limits || { maxChunkInputBytes: 4096, maxResultBytes: 4096 }
    this.configurationSnapshots = []
    this.configurationWasFrozen = []
    this.borrowedCredentials = []
    this.credentialAvailableDuringCall = []
    this.responseSettled = []
    this.started = new Promise((resolve) => { this.resolveStarted = resolve })
  }

  output (request) {
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

  async openModel ({ configuration, request, credential, signal }) {
    const faux = await import('@earendil-works/pi-ai/providers/faux')
    this.configurationSnapshots.push(structuredClone(configuration))
    this.configurationWasFrozen.push(Object.isFrozen(configuration))
    this.borrowedCredentials.push(credential)
    this.calls.push(structuredClone(request))
    this.credentialAvailableDuringCall.push(
      Buffer.isBuffer(credential) && credential.some((byte) => byte !== 0)
    )
    this.resolveStarted()
    if (this.pending) {
      await new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason)
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
    }
    let reportResponseSettled
    const shouldRejectHandle = this.extraHandleFieldOnce && !this.extraHandleFieldReturned
    if (!shouldRejectHandle) {
      this.responseSettled.push(new Promise((resolve) => { reportResponseSettled = resolve }))
    }
    const response = async () => {
      try {
        if (this.authFailure) {
          return faux.fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'HTTP 401 invalid api key'
          })
        }
        if (request.operation === 'meeting-minutes.merge' && this.failMergeOnce && !this.failedMerge) {
          this.failedMerge = true
          return faux.fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'HTTP 408 request timeout'
          })
        }
        return faux.fauxAssistantMessage(JSON.stringify(this.output(request)))
      } finally {
        reportResponseSettled?.()
      }
    }
    const core = faux.createFauxCore({
      provider: 'deterministic-test',
      api: 'formal-minutes-test',
      models: [{ id: 'fixture-model' }]
    })
    core.setResponses([response])
    const handle = { model: core.getModel(), streamFn: core.streamSimple }
    if (shouldRejectHandle) {
      this.extraHandleFieldReturned = true
      return { ...handle, apiKey: undefined }
    }
    return handle
  }
}

async function assertProviderCallBoundary (provider, bootstrap, expectedCredentialState = 'startup_environment') {
  await Promise.all(provider.responseSettled)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(provider.calls.length > 0, true)
  assert.equal(provider.borrowedCredentials.length, provider.calls.length)
  assert.equal(provider.configurationWasFrozen.every(Boolean), true)
  assert.equal(provider.credentialAvailableDuringCall.every(Boolean), true)
  assert.equal(provider.borrowedCredentials.every((credential) =>
    credential.every((byte) => byte === 0)
  ), true)
  assert.equal(provider.configurationSnapshots.every((configuration) =>
    configuration.providerId === 'deepseek' &&
    configuration.providerKind === 'cloud' &&
    configuration.apiStyle === 'openai-chat-completions' &&
    configuration.baseUrl === 'https://api.deepseek.com' &&
    configuration.model === 'deepseek-v4-flash' &&
    configuration.maxChunkInputBytes === provider.limits.maxChunkInputBytes &&
    configuration.maxResultBytes === provider.limits.maxResultBytes &&
    configuration.timeoutMs === 5000
  ), true)
  assert.equal(bootstrap.getPublicState().credentialState, expectedCredentialState)
}

function runtime (t, client, provider, clock, options = {}) {
  const defaultConfig = DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG.providers[0]
  const startupEnvironment = {
    [CREDENTIAL_ENV_NAME]: 'synthetic-d10-minutes-credential'
  }
  const bootstrap = new AgentProviderBootstrap({
    environment: startupEnvironment,
    configCatalog: {
      schemaVersion: 1,
      providers: [{
        ...defaultConfig,
        ...provider.limits,
        timeoutMs: options.modelTimeoutMs || 5000
      }]
    }
  })
  const providerRegistry = new AgentModelProviderRegistry({
    bootstrap,
    adapters: [{
      providerId: 'deepseek',
      providerKind: 'cloud',
      apiStyle: 'openai-chat-completions',
      openModel: (request) => provider.openModel(request)
    }]
  })
  t.after(() => providerRegistry.dispose())
  assert.equal(Object.hasOwn(startupEnvironment, CREDENTIAL_ENV_NAME), false)
  const modelGateway = new ModelGateway({
    providerRegistry
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
  return { bootstrap, host, providerRegistry, runner }
}

test('SEM-F15/F16/F28 / D10/J24-B02/B19/B20/B29 runs registry-backed ModelGateway/Pi minutes and leaves unavailable tasks queued', async (t) => {
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

  assert.throws(
    () => new ModelGateway({ providerRegistry: { resolve: async () => undefined } }),
    (error) => error.code === 'AGENT_REQUEST_INVALID'
  )
  const provider = new DeterministicMinutesProvider({ emptySections: true })
  const { bootstrap, runner } = runtime(t, client, provider, clock)
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
  await assertProviderCallBoundary(provider, bootstrap)
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
  const { bootstrap, runner } = runtime(t, client, provider, clock)
  const result = await runner.runNext({ claimIdempotencyKey: 'refined-claim', localWorkAllowed: false })
  assert.equal(result.jobState, 'succeeded')
  assert.deepEqual(
    provider.calls.filter((call) => call.operation === 'meeting-minutes.chunk')
      .flatMap((call) => call.input.segments.map((segment) => segment.eventOrder)),
    [3, 4]
  )
  assert.equal(result.artifact.inputRef.transcriptVersion, 'refined')
  assert.deepEqual(result.artifact.inputRef, refinedSnapshot.inputRef)
  await assertProviderCallBoundary(provider, bootstrap)
})

test('SEM-F28 / D10/J24-B03/B06/B27/B28 retries one registry-backed long frozen input without partial artifacts', async (t) => {
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
  const { bootstrap, runner } = runtime(t, client, provider, clock)
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
  await assertProviderCallBoundary(provider, bootstrap)
})

test('SEM-F09/F28 / D10/J24-B10 cancels while the registry opens a model and rejects its late result', async (t) => {
  const clock = { value: 30000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, { sessionId: 'cancel-session', captions: ['synthetic cancellation input'] })
  const reconciled = prepareJobs(client, 'cancel-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({ pending: true })
  const { bootstrap, runner } = runtime(t, client, provider, clock)
  const running = runner.runNext({ claimIdempotencyKey: 'cancel-claim', localWorkAllowed: false })
  await provider.started
  const requested = await runner.cancel(runId)
  assert.equal(requested.state, 'running')
  const settled = await running
  assert.equal(settled.jobState, 'cancelled')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  assert.equal(client.service.store.database.prepare('SELECT state FROM agent_jobs WHERE run_id = ?').get(runId).state, 'cancelled')
  await assertProviderCallBoundary(provider, bootstrap)
})

test('SEM-F09/F15/F28 / D10/J24-B12 rejects an extra model-handle field and then invalid output without changing subtitle facts', async (t) => {
  const clock = { value: 40000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, { sessionId: 'invalid-output-session', sourceId: 'mic', captions: ['synthetic ownerless input'] })
  const reconciled = prepareJobs(client, 'invalid-output-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({ invalidOwner: true, extraHandleFieldOnce: true })
  const { bootstrap, runner } = runtime(t, client, provider, clock)
  const first = await runner.runNext({ claimIdempotencyKey: 'invalid-handle-claim', localWorkAllowed: false })
  assert.equal(first.jobState, 'retry_wait')
  assert.equal(client.service.store.database.prepare(
    'SELECT error_code FROM agent_jobs WHERE run_id = ?'
  ).get(runId).error_code, 'AGENT_PROVIDER_UNAVAILABLE')
  const result = await runner.runNext({ claimIdempotencyKey: 'invalid-output-claim', localWorkAllowed: false })
  assert.equal(result.jobState, 'failed')
  const jobRow = client.service.store.database.prepare(
    'SELECT state, error_code FROM agent_jobs WHERE run_id = ?'
  ).get(runId)
  assert.equal(jobRow.state, 'failed')
  assert.equal(jobRow.error_code, 'AGENT_OUTPUT_INVALID')
  assert.equal(client.service.store.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  assert.equal(client.call(OPERATIONS.GET_SESSION, { sessionId: 'invalid-output-session' }).segments.length, 1)
  await assertProviderCallBoundary(provider, bootstrap)
})

test('SEM-F25/F28 / D10/J24-B12/B23 invalidates the startup credential after stable provider authentication failure', async (t) => {
  const clock = { value: 50000 }
  const client = journeyClient(t, clock)
  createTerminalSession(client, {
    sessionId: 'provider-auth-failure-session',
    captions: ['synthetic provider authentication boundary']
  })
  const reconciled = prepareJobs(client, 'provider-auth-failure-session')
  const runId = reconciled.jobs.find((entry) => entry.job.taskKind === 'meeting-minutes').job.runId
  const provider = new DeterministicMinutesProvider({ authFailure: true })
  const { bootstrap, runner } = runtime(t, client, provider, clock)

  const result = await runner.runNext({
    claimIdempotencyKey: 'provider-auth-failure-claim',
    localWorkAllowed: false
  })

  assert.equal(result.jobState, 'failed')
  const jobRow = client.service.store.database.prepare(
    'SELECT state, error_code AS errorCode FROM agent_jobs WHERE run_id = ?'
  ).get(runId)
  assert.equal(jobRow.state, 'failed')
  assert.equal(jobRow.errorCode, 'AGENT_PROVIDER_AUTH_FAILED')
  assert.equal(client.service.store.database.prepare(
    'SELECT COUNT(*) AS count FROM agent_artifacts'
  ).get().count, 0)
  assert.equal(client.call(OPERATIONS.GET_SESSION, {
    sessionId: 'provider-auth-failure-session'
  }).segments.length, 1)
  await assertProviderCallBoundary(provider, bootstrap, 'invalid')
  assert.equal(bootstrap.getEligibilityProviderFacts().credentialAvailable, false)
})
