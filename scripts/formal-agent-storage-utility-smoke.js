'use strict'

/* D6/D12/D13 确定性组合：Electron main → SessionCoordinator →
   MeetingStoppedPersistenceSink → SqliteSessionRecorder → StorageGateway →
   production StorageWorkerHost/storage utility/SQLite，再由正式
   AgentPluginHost / ModelGateway / Pi Agent Loop / job runner 消费。
   只替代声卡输入与 Agent 模型 provider；不开 BrowserWindow，不写报告文件。 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { AgentInputPlanner } = require('../src/agent-core/formal/input-planner')
const { AgentJobRunner } = require('../src/agent-core/formal/job-runner')
const { ModelGateway } = require('../src/agent-core/formal/model-gateway')
const { AgentPluginHost } = require('../src/agent-core/formal/plugin-host')
const { MemoryReader, TranscriptReader } = require('../src/agent-core/formal/storage-ports')
const { AgentModelProviderRegistry } = require('../src/agent-provider/model-provider-registry')
const { AgentProviderBootstrap } = require('../src/agent-provider/provider-bootstrap')
const {
  FormalAgentRuntime,
  MeetingStoppedPersistenceSink
} = require('../src/agent-runtime/formal-agent-runtime')
const { ConfigStore } = require('../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../src/main/services/storage-gateway')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../src/main/runtime-options')
const { FakeRuntimeAdapter } = require('../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { StorageWorkerHost } = require('../src/runtime/storage-worker/worker-host')

const DISABLED_SESSION_ID = 'formal-agent-disabled-session'
const READY_SESSION_ID = 'formal-agent-ready-session'
const EMPTY_SESSION_ID = 'formal-agent-empty-session'
const TERMINAL_SESSION_IDS = Object.freeze([
  DISABLED_SESSION_ID,
  READY_SESSION_ID,
  EMPTY_SESSION_ID
])
const TASK_KINDS = Object.freeze([
  'meeting-minutes',
  'memory-extraction',
  'enhanced-transcript'
])
const REPORT_KIND = 'formal-agent-storage-utility-journey'

function parseArguments (argv) {
  const indexes = argv.flatMap((value, index) => value === '--data-root' ? [index] : [])
  const index = indexes[0]
  if (indexes.length !== 1 || index + 1 >= argv.length || !path.isAbsolute(argv[index + 1])) {
    throw new Error('invalid arguments')
  }
  return { dataRoot: argv[index + 1] }
}

function captionEvent (sessionId, sequence, text) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId: 'loopback',
    segmentId: `${sessionId}-segment-${sequence}`,
    sequence,
    revision: 1,
    kind: 'final',
    t0: sequence - 1,
    t1: sequence,
    text,
    translation: null
  }
}

function evidenceForSegments (segments) {
  return [{
    fromEventOrder: Math.min(...segments.map((segment) => segment.eventOrder)),
    throughEventOrder: Math.max(...segments.map((segment) => segment.eventOrder))
  }]
}

class D13DeterministicProvider {
  constructor ({ afterFirstModelResult = null } = {}) {
    if (afterFirstModelResult !== null && typeof afterFirstModelResult !== 'function') {
      throw new TypeError('afterFirstModelResult must be a function')
    }
    this.calls = []
    this.afterFirstModelResult = afterFirstModelResult
  }

  resultFor (request) {
    const evidence = evidenceForSegments(request.input.segments)
    if (request.operation === 'meeting-minutes.chunk') {
      return {
        type: 'meeting-minutes',
        content: {
          overview: 'synthetic utility transport overview',
          conclusions: [],
          actionItems: [],
          risks: []
        }
      }
    }
    if (request.operation === 'memory-extraction.chunk') {
      return {
        type: 'memory-candidates',
        candidates: [{
          kind: 'decision',
          semanticKey: 'decision:formal-agent-utility',
          scope: {
            kind: 'session',
            canonicalKey: request.input.inputRef.sessionId,
            label: 'synthetic utility session'
          },
          origin: 'explicit',
          content: { statement: 'synthetic utility decision' },
          evidence,
          confidenceBand: 'high',
          salienceBand: 'high'
        }]
      }
    }
    if (request.operation === 'enhanced-transcript.chunk') {
      return {
        type: 'enhanced-transcript',
        content: {
          paragraphs: [{ text: 'synthetic enhanced utility transcript', evidence }]
        }
      }
    }
    throw new Error('unexpected operation')
  }

  async openModel ({ request, credential }) {
    if (!Buffer.isBuffer(credential) || !credential.some((byte) => byte !== 0)) {
      throw new Error('credential unavailable')
    }
    const faux = await import('@earendil-works/pi-ai/providers/faux')
    this.calls.push(structuredClone(request))
    const core = faux.createFauxCore({
      provider: 'deterministic-test',
      api: 'formal-agent-storage-utility-test',
      models: [{ id: 'deepseek-v4-flash' }]
    })
    core.setResponses([faux.fauxAssistantMessage(JSON.stringify(this.resultFor(request)))])
    const streamFn = (...args) => {
      const stream = core.streamSimple(...args)
      const afterFirstModelResult = this.afterFirstModelResult
      this.afterFirstModelResult = null
      if (!afterFirstModelResult) return stream
      let finalResult = null
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        result: () => {
          if (!finalResult) {
            finalResult = stream.result().then(async (message) => {
              await afterFirstModelResult()
              return message
            })
          }
          return finalResult
        }
      }
    }
    return { model: core.getModel(), streamFn }
  }
}

function createAgentJobRuntime (storage, provider, bootstrap) {
  const providerRegistry = new AgentModelProviderRegistry({
    bootstrap,
    adapters: [{
      providerId: 'deepseek',
      providerKind: 'cloud',
      apiStyle: 'openai-chat-completions',
      openModel: (request) => provider.openModel(request)
    }]
  })
  const modelGateway = new ModelGateway({ providerRegistry })
  const pluginHost = new AgentPluginHost({
    transcriptReader: new TranscriptReader(storage),
    inputPlanner: new AgentInputPlanner(),
    modelGateway
  })
  const runner = new AgentJobRunner({
    storage,
    pluginHost,
    owner: 'formal-agent-utility-runner',
    leaseMs: 5000,
    retryDelaysMs: [0]
  })
  return { pluginHost, providerRegistry, runner }
}

function identityHash (inputRef, runIds) {
  return crypto.createHash('sha256').update(JSON.stringify({
    inputDigest: inputRef.inputDigest,
    runIds: [...runIds].sort()
  })).digest('hex')
}

function sleep (delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function waitForMeetingStopped (agentRuntime) {
  await new Promise((resolve) => setImmediate(resolve))
  await agentRuntime.whenIdle()
}

function countAudioFiles (directory) {
  let count = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) count += countAudioFiles(path.join(directory, entry.name))
    else if (entry.isFile() && /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) count += 1
  }
  return count
}

async function terminateQuietly (target) {
  if (!target) return
  if (typeof target.terminate === 'function') {
    await target.terminate().catch(() => {})
    return
  }
  if (target.child !== null && typeof target.terminateAndWait === 'function') {
    await target.terminateAndWait(5000).catch(() => {})
  }
}

async function main () {
  let phase = 'arguments'
  let storageGateway = null
  let agentRuntime = null
  let coordinator = null
  let providerBootstrap = null
  let providerRegistry = null
  try {
    const { dataRoot } = parseArguments(process.argv)
    const userData = path.join(dataRoot, 'electron-user-data')
    const dataDirectory = path.join(dataRoot, 'data')
    const databasePath = path.join(dataDirectory, 'speech-agent.sqlite3')
    const configPath = path.join(dataDirectory, 'config.json')
    fs.mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
    app.on('window-all-closed', () => {})

    phase = 'provider-bootstrap'
    providerBootstrap = new AgentProviderBootstrap({ environment: process.env })
    const clock = { value: 10 }
    const configStore = new ConfigStore(configPath, { now: () => clock.value })
    configStore.load()
    configStore.applyPreset('meeting')

    phase = 'app-ready'
    await app.whenReady()

    phase = 'formal-runtime-start'
    const storageGenerations = []
    storageGateway = new StorageGateway({
      databasePath,
      maxRestarts: 2,
      requestTimeoutMs: 10000,
      hostFactory: (options) => {
        const host = new StorageWorkerHost(options)
        storageGenerations.push(host)
        return host
      }
    })
    await storageGateway.start()

    const diagnostics = []
    let localModelReady = false
    agentRuntime = new FormalAgentRuntime({
      storage: storageGateway,
      configStore,
      providerBootstrap,
      getLocalModelReady: () => localModelReady,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })
    const initialRecovery = await agentRuntime.recoverTerminalSessions({ sessionIds: [] })

    phase = 'invalid-policy-context'
    localModelReady = null
    let invalidPolicyRejected = false
    try {
      await agentRuntime.recoverTerminalSessions({ sessionIds: [] })
    } catch (error) {
      invalidPolicyRejected = error?.code === 'AGENT_RUNTIME_CONFIGURATION_INVALID'
    }
    const invalidPolicyFailsClosed = invalidPolicyRejected &&
      agentRuntime.isTaskPolicyReady() === false &&
      agentRuntime.getTaskPolicyRevision() === null &&
      diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_TASK_POLICY_APPLY_FAILED').length === 1
    localModelReady = false
    const restoredInitialPolicy = await agentRuntime.recoverTerminalSessions({ sessionIds: [] })

    const recorder = new SqliteSessionRecorder({
      gateway: storageGateway,
      now: () => clock.value
    })
    const persistenceSink = new MeetingStoppedPersistenceSink({
      subtitleSink: recorder,
      agentRuntime
    })
    const adapter = new FakeRuntimeAdapter({ autoEmit: false })
    let sessionIndex = 0
    coordinator = new SessionCoordinator({
      adapter,
      runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
      configuration: configStore.get(),
      idFactory: () => TERMINAL_SESSION_IDS[sessionIndex++],
      persistenceSink
    })

    phase = 'agent-disabled-session'
    clock.value = 100
    const disabledStart = await coordinator.command('start')
    if (!disabledStart.ok || coordinator.getSnapshot().sessionId !== DISABLED_SESSION_ID) {
      throw new Error('disabled session start invariant')
    }
    adapter.emitCaption(captionEvent(
      DISABLED_SESSION_ID,
      1,
      'D12 synthetic committed transcript before Agent enable'
    ))
    clock.value = 150
    const disabledStop = await coordinator.command('stop')
    await waitForMeetingStopped(agentRuntime)

    phase = 'agent-settings-enable'
    clock.value = 200
    const enabled = await agentRuntime.updateAgentSettings({
      expectedRevision: 0,
      agentEnabled: true,
      memoryEnabled: true,
      cloudDisclosureAccepted: true
    })

    phase = 'meeting-stopped-detached-reconciliation'
    clock.value = 210
    const readyStart = await coordinator.command('start')
    if (!readyStart.ok || coordinator.getSnapshot().sessionId !== READY_SESSION_ID) {
      throw new Error('ready session start invariant')
    }
    adapter.emitCaption(captionEvent(
      READY_SESSION_ID,
      1,
      'D12 synthetic committed transcript first'
    ))
    adapter.emitCaption(captionEvent(
      READY_SESSION_ID,
      2,
      'D12 synthetic committed transcript second'
    ))
    clock.value = 220
    const readyStop = await coordinator.command('stop')
    const stopReturnedBeforeNotification = readyStop.ok &&
      coordinator.getSnapshot().phase === 'idle' &&
      diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 0

    phase = 'real-storage-notification-failure'
    const notificationFailureHost = storageGateway.host
    const notificationFailureChild = notificationFailureHost?.child
    if (!notificationFailureHost || notificationFailureHost.state !== 'ready' || !notificationFailureChild) {
      throw new Error('notification failure child unavailable')
    }
    const notificationFailureExitPromise = notificationFailureHost.waitForExactExit()
    const notificationFailureTermination = notificationFailureHost.terminateAndWait(10000)
    clock.value = 230
    const emptyStartPromise = coordinator.command('start')
    await new Promise((resolve) => setImmediate(resolve))
    const emptyStart = await emptyStartPromise
    const notificationFailureTerminationExitCode = await notificationFailureTermination
    const notificationFailureJoinedExitCode = await notificationFailureExitPromise
    await agentRuntime.whenIdle()
    const notificationFailureChildReaped = notificationFailureTerminationExitCode !== null &&
      notificationFailureTerminationExitCode === notificationFailureJoinedExitCode &&
      notificationFailureHost.terminationChild === notificationFailureChild &&
      notificationFailureHost.child === null &&
      notificationFailureHost.state === 'stopped'
    const nextSessionStartedBeforeNotificationRecovery = emptyStart.ok &&
      coordinator.getSnapshot().sessionId === EMPTY_SESSION_ID
    const notificationFailureObserved =
      diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 1 &&
      agentRuntime.isTaskPolicyReady() === false &&
      agentRuntime.getTaskPolicyRevision() === null

    phase = 'first-replacement-before-policy'
    const firstBlockedBeforePolicy = await storageGateway.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-first-claim-before-policy',
      owner: 'formal-agent-utility-first-replacement',
      leaseMs: 5000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })

    phase = 'notification-failure-recovery'
    const notificationFailureRecovery = await agentRuntime.recoverTerminalSessions({
      sessionIds: [READY_SESSION_ID]
    })
    const firstRepeatedMeetingStopped = agentRuntime.notifyMeetingStopped({ sessionId: READY_SESSION_ID })
    const duplicateMeetingStopped = agentRuntime.notifyMeetingStopped({ sessionId: READY_SESSION_ID })
    await agentRuntime.whenIdle()

    clock.value = 240
    const emptyStop = await coordinator.command('stop')
    await waitForMeetingStopped(agentRuntime)

    phase = 'claim-before-storage-replacement'
    const context = agentRuntime.getEligibilityContext()
    const reconciledDetail = await storageGateway.getAgentSessionDetail({
      sessionId: READY_SESSION_ID,
      eligibilityContext: context
    })
    const originalRunIds = reconciledDetail.jobs.map((job) => job.runId)
    const claimedBeforeExit = await storageGateway.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-claim-before-exit',
      owner: 'formal-agent-utility-before-exit',
      leaseMs: 1000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })
    if (!claimedBeforeExit || claimedBeforeExit.taskKind !== 'meeting-minutes') {
      throw new Error('claim invariant')
    }

    phase = 'exact-child-exit'
    const claimedJobHost = storageGateway.host
    const exactChild = claimedJobHost?.child
    if (!claimedJobHost || claimedJobHost.state !== 'ready' || !exactChild) throw new Error('exact child unavailable')
    const exactExitPromise = claimedJobHost.waitForExactExit()
    const terminationExitCode = await claimedJobHost.terminateAndWait(10000)
    const joinedExitCode = await exactExitPromise
    const exactChildReaped = terminationExitCode !== null &&
      terminationExitCode === joinedExitCode &&
      claimedJobHost.terminationChild === exactChild &&
      claimedJobHost.child === null &&
      claimedJobHost.state === 'stopped'

    phase = 'replacement-before-policy'
    const blockedBeforePolicy = await storageGateway.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-claim-before-policy',
      owner: 'formal-agent-utility-replacement',
      leaseMs: 5000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })
    const replacementHost = storageGateway.host

    phase = 'replacement-policy-and-recovery'
    const recoveredSessions = await agentRuntime.recoverTerminalSessions({
      sessionIds: TERMINAL_SESSION_IDS
    })
    const recoveryBySession = Object.fromEntries(
      recoveredSessions.sessions.map((session) => [session.sessionId, session])
    )

    phase = 'same-run-recovery'
    let runnerCommitReplacement = null
    const provider = new D13DeterministicProvider({
      afterFirstModelResult: async () => {
        const host = storageGateway.host
        const child = host?.child
        if (!host || host.state !== 'ready' || !child) {
          throw new Error('runner commit replacement child unavailable')
        }
        const exactExitPromise = host.waitForExactExit()
        const terminationExitCode = await host.terminateAndWait(10000)
        const joinedExitCode = await exactExitPromise
        runnerCommitReplacement = {
          host,
          child,
          terminationExitCode,
          joinedExitCode
        }
      }
    })
    const runtime = createAgentJobRuntime(storageGateway, provider, providerBootstrap)
    const { pluginHost, runner } = runtime
    providerRegistry = runtime.providerRegistry
    const waitMs = Math.max(0, claimedBeforeExit.lease.expiresAt - Date.now() + 30)
    if (waitMs > 2000) throw new Error('lease wait invariant')
    await sleep(waitMs)
    const recovered = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-recovery-claim',
      localWorkAllowed: false
    })

    phase = 'runner-replacement-before-policy'
    const runnerReplacementHost = storageGateway.host
    const runnerReplacementPolicyReadyBeforeRecovery = agentRuntime.isTaskPolicyReady()
    const runnerReplacementBlocked = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-runner-replacement-before-policy',
      localWorkAllowed: false
    })

    phase = 'runner-replacement-policy-recovery'
    const runnerReplacementRecovery = await agentRuntime.recoverTerminalSessions({
      sessionIds: TERMINAL_SESSION_IDS
    })
    const memory = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-memory-claim',
      localWorkAllowed: false
    })
    const enhanced = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-enhanced-claim',
      localWorkAllowed: false
    })
    const empty = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-empty-claim',
      localWorkAllowed: false
    })

    phase = 'memory-read-through-storage-gateway'
    const memoryProjection = await new MemoryReader(storageGateway).query({
      scopeRefs: [{ kind: 'session', canonicalKey: READY_SESSION_ID }],
      kinds: ['decision'],
      semanticKeys: ['decision:formal-agent-utility'],
      maxItems: 4,
      maxSerializedBytes: 16384
    })

    phase = 'authority-readback'
    const detail = await storageGateway.getAgentSessionDetail({
      sessionId: READY_SESSION_ID,
      eligibilityContext: agentRuntime.getEligibilityContext()
    })
    const stats = await storageGateway.getStats()
    const currentRunIds = detail.jobs.map((job) => job.runId)
    const recoveredJob = detail.jobs.find((job) => job.runId === claimedBeforeExit.runId)
    const artifactTypes = detail.artifacts.map((artifact) => artifact.type).sort()
    const readyRecovery = recoveryBySession[READY_SESSION_ID]
    const checks = {
      threeJobsReconciled: reconciledDetail.jobs.length === 3 &&
        reconciledDetail.jobs.every((job) =>
          job.sessionId === READY_SESSION_ID && job.providerId === 'deepseek' &&
          job.providerKind === 'cloud' && job.model === 'deepseek-v4-flash') &&
        new Set(reconciledDetail.jobs.map((job) => JSON.stringify(job.inputRef))).size === 1,
      meetingStoppedDetached: disabledStop.ok && emptyStop.ok && stopReturnedBeforeNotification,
      nextSessionStartedBeforeNotificationRecovery,
      disabledAndEmptySessionsSkipped: recoveryBySession[DISABLED_SESSION_ID]?.eligibility === 'outside_automatic_window' &&
        recoveryBySession[DISABLED_SESSION_ID]?.jobCount === 0 &&
        recoveryBySession[EMPTY_SESSION_ID]?.eligibility === 'no_committed_transcript' &&
        recoveryBySession[EMPTY_SESSION_ID]?.jobCount === 0,
      duplicateMeetingStoppedCoalesced: firstRepeatedMeetingStopped.accepted === true &&
        firstRepeatedMeetingStopped.coalesced === false &&
        duplicateMeetingStopped.accepted === true &&
        duplicateMeetingStopped.coalesced === true,
      invalidPolicyFailsClosed,
      notificationFailureDeferred: notificationFailureObserved &&
        diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_TASK_POLICY_APPLY_FAILED').length === 1 &&
        diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 1 &&
        notificationFailureRecovery.sessions[0]?.createdJobCount === 3,
      notificationFailureChildReaped,
      exactChildReaped,
      replacementBlockedBeforePolicy: firstBlockedBeforePolicy === null && blockedBeforePolicy === null,
      runnerCommitReplacementChildReaped: runnerCommitReplacement !== null &&
        runnerCommitReplacement.host === replacementHost &&
        runnerCommitReplacement.terminationExitCode !== null &&
        runnerCommitReplacement.terminationExitCode === runnerCommitReplacement.joinedExitCode &&
        runnerCommitReplacement.host.terminationChild === runnerCommitReplacement.child &&
        runnerCommitReplacement.host.child === null &&
        runnerCommitReplacement.host.state === 'stopped',
      runnerCommitReplayedThroughGateway: runnerCommitReplacement !== null &&
        runnerReplacementHost !== null &&
        runnerReplacementHost !== runnerCommitReplacement.host &&
        recovered?.runId === claimedBeforeExit.runId && recovered?.jobState === 'succeeded',
      runnerReplacementBlockedBeforePolicy: runnerReplacementPolicyReadyBeforeRecovery === false &&
        runnerReplacementBlocked === null && runnerReplacementRecovery.sessions.length === 3,
      taskPolicyReplayedBeforeRecovery: initialRecovery.sessions.length === 0 &&
        restoredInitialPolicy.sessions.length === 0 &&
        enabled.settings.agentSettingsRevision === 1 && agentRuntime.isTaskPolicyReady() &&
        agentRuntime.getTaskPolicyRevision() === 1,
      duplicateReconciliationIdempotent: readyRecovery?.createdJobCount === 0 &&
        readyRecovery?.alreadyProcessedJobCount === 3 && detail.jobs.length === 3,
      sameRunRecovered: recovered?.runId === claimedBeforeExit.runId && recovered?.jobState === 'succeeded' &&
        recoveredJob?.attemptCount === 2,
      taskIdentityStable: JSON.stringify([...originalRunIds].sort()) === JSON.stringify([...currentRunIds].sort()),
      independentResultsCommitted: memory?.jobState === 'succeeded' && memory?.memory?.acceptedCandidateCount === 1 &&
        enhanced?.jobState === 'succeeded' && enhanced?.artifact?.type === 'enhanced-transcript',
      memoryReadThroughGateway: memoryProjection.availability === 'ready' &&
        memoryProjection.reason === null && memoryProjection.items.length === 1 &&
        memoryProjection.items[0].semanticKey === 'decision:formal-agent-utility' &&
        memoryProjection.itemCount === 1 && memoryProjection.hasMore === false,
      noDuplicateClaims: empty === null && detail.jobs.length === 3 &&
        detail.jobs.every((job) => job.state === 'succeeded'),
      artifactProjectionExact: detail.artifacts.length === 2 &&
        JSON.stringify(artifactTypes) === JSON.stringify(['enhanced-transcript', 'meeting-minutes']),
      pluginTaskClosureExact: JSON.stringify(pluginHost.availableTaskKinds()) === JSON.stringify(TASK_KINDS),
      eligibilityContextExact: JSON.stringify(Object.keys(context).sort()) === JSON.stringify([
        'agentEnabled',
        'automaticProcessingSince',
        'cloudDisclosureAccepted',
        'credentialAvailable',
        'localModelReady',
        'memoryEnabled',
        'memoryProcessingSince',
        'model',
        'providerId',
        'providerKind'
      ]) && !Object.hasOwn(context, 'apiKey') && !Object.hasOwn(context, 'baseUrl'),
      captionFactsPreserved: stats.sessions === 3 && stats.activeSessions === 0 &&
        stats.captionEvents === 3 && stats.segments === 3 && stats.integrity === 'ok'
    }
    const failedChecks = Object.entries(checks)
      .filter(([, value]) => value !== true)
      .map(([name]) => name)
    if (failedChecks.length !== 0) throw new Error('journey assertion')

    phase = 'graceful-shutdown'
    const finalStorageHost = storageGateway.host
    await coordinator.dispose()
    coordinator = null
    agentRuntime.dispose()
    agentRuntime = null
    await storageGateway.shutdown()
    const gracefulExactExit = storageGateway.host === null &&
      finalStorageHost?.child === null && finalStorageHost?.state === 'closed'
    if (!gracefulExactExit) throw new Error('shutdown invariant')
    storageGateway = null
    providerRegistry.dispose()
    providerRegistry = null
    providerBootstrap = null
    const browserWindowCount = BrowserWindow.getAllWindows().length
    const audioFileCount = countAudioFiles(dataRoot)
    if (browserWindowCount !== 0 || audioFileCount !== 0) throw new Error('privacy invariant')

    const report = {
      schemaVersion: 1,
      kind: REPORT_KIND,
      result: 'pass',
      checks: { ...checks, gracefulExactExit },
      metrics: {
        storageGenerationCount: storageGenerations.length,
        jobCount: detail.jobs.length,
        artifactCount: detail.artifacts.length,
        memoryCommitCount: memory.memory.acceptedCandidateCount === 1 ? 1 : 0,
        providerCallCount: provider.calls.length,
        recoveredAttemptCount: recoveredJob.attemptCount
      },
      identityHash: identityHash(reconciledDetail.jobs[0].inputRef, originalRunIds),
      scope: {
        storageUtilityProcess: true,
        agentUtilityProcess: false,
        meetingStoppedWiring: true,
        meetingStoppedStorageGatewayWiring: true,
        agentJobRunnerStorageGatewayWiring: true,
        preloadIpcRenderer: false,
        packagedRuntime: false
      },
      privacy: {
        noBrowserWindowCreated: browserWindowCount === 0,
        browserWindowCount,
        reportContainsTranscriptText: false,
        reportContainsAbsolutePath: false,
        persistedAudio: audioFileCount !== 0,
        audioFileCount
      }
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
    app.exit(0)
  } catch {
    if (agentRuntime) agentRuntime.dispose()
    if (coordinator) await coordinator.dispose().catch(() => {})
    if (providerRegistry) providerRegistry.dispose()
    else if (providerBootstrap) providerBootstrap.dispose()
    await terminateQuietly(storageGateway)
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: REPORT_KIND,
      result: 'fail',
      failurePhase: phase
    })}\n`)
    app.exit(1)
  }
}

main().catch(() => app.exit(1))
