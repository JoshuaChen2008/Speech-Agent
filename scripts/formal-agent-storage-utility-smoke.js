'use strict'

/* D6/D12/D13/D14 确定性组合：两次 UI-free Electron main 启动共享同一
   SQLite；字幕提交与任务存储经过正式 storage utility，模型执行经过正式
   Agent utility。只替代声卡输入与 Agent 模型 provider，不写报告文件。 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { AgentJobRunner } = require('../src/agent-core/formal/job-runner')
const { MemoryReader } = require('../src/agent-core/formal/storage-ports')
const { AgentProviderBootstrap } = require('../src/agent-provider/provider-bootstrap')
const {
  AgentUtilityPluginProxy
} = require('../src/agent-runtime/agent-utility/plugin-proxy')
const {
  AgentUtilityWorkerHost
} = require('../src/agent-runtime/agent-utility/worker-host')
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
const PROVIDER_RESULT_MARKER = 'D14_AGENT_PROVIDER_RESULT\n'
const AGENT_UTILITY_FIXTURE = path.join(__dirname, 'fixtures', 'formal-agent-utility-worker.js')

function parseArguments (argv) {
  const dataIndexes = argv.flatMap((value, index) => value === '--data-root' ? [index] : [])
  const phaseIndexes = argv.flatMap((value, index) => value === '--phase' ? [index] : [])
  const dataIndex = dataIndexes[0]
  const phaseIndex = phaseIndexes[0]
  if (dataIndexes.length !== 1 || phaseIndexes.length !== 1 ||
      dataIndex + 1 >= argv.length || phaseIndex + 1 >= argv.length ||
      !path.isAbsolute(argv[dataIndex + 1]) ||
      !['initial', 'recovery'].includes(argv[phaseIndex + 1])) {
    throw new Error('invalid arguments')
  }
  return { dataRoot: argv[dataIndex + 1], journeyPhase: argv[phaseIndex + 1] }
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
  if (typeof target.terminateAndWait === 'function') {
    await target.terminateAndWait(5000).catch(() => {})
  }
}

function observeFixtureOutput (host) {
  const child = host.child
  if (!child?.stdout || !child?.stderr) throw new Error('fixture stdio unavailable')
  let stdout = ''
  let stderr = ''
  let overflow = false
  const append = (field, chunk) => {
    const value = chunk.toString('utf8')
    if (field === 'stdout') {
      stdout += value
      if (stdout.length > 4096) { stdout = stdout.slice(0, 4096); overflow = true }
    } else {
      stderr += value
      if (stderr.length > 4096) { stderr = stderr.slice(0, 4096); overflow = true }
    }
  }
  child.stdout.on('data', (chunk) => append('stdout', chunk))
  child.stderr.on('data', (chunk) => append('stderr', chunk))
  const closed = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    stream.once('end', finish)
    stream.once('close', finish)
  })))
  return {
    async snapshot () {
      await Promise.race([closed, sleep(1000)])
      const markerCount = stdout.split(PROVIDER_RESULT_MARKER).length - 1
      return {
        markerCount,
        exact: !overflow && stderr === '' && stdout === PROVIDER_RESULT_MARKER.repeat(markerCount)
      }
    }
  }
}

function createStorageGateway (databasePath, storageGenerations) {
  return new StorageGateway({
    databasePath,
    maxRestarts: 2,
    requestTimeoutMs: 10000,
    hostFactory: (options) => {
      const host = new StorageWorkerHost(options)
      storageGenerations.push(host)
      return host
    }
  })
}

async function createAgentUtility ({ storage, providerBootstrap, scenario }) {
  const workerHost = new AgentUtilityWorkerHost({
    environment: providerBootstrap.getChildEnvironment(),
    workerPath: AGENT_UTILITY_FIXTURE,
    workerArgs: ['--scenario', scenario],
    requestTimeoutMs: 10000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const pluginProxy = new AgentUtilityPluginProxy({
    storage,
    workerHost,
    providerBootstrap
  })
  await workerHost.start()
  const output = observeFixtureOutput(workerHost)
  return { workerHost, pluginProxy, output }
}

function createRunner (storage, pluginHost) {
  return new AgentJobRunner({
    storage,
    pluginHost,
    owner: 'formal-agent-utility-runner',
    leaseMs: 5000,
    retryDelaysMs: [250]
  })
}

function exactEligibilityContext (context) {
  return JSON.stringify(Object.keys(context).sort()) === JSON.stringify([
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
  ]) && !Object.hasOwn(context, 'apiKey') && !Object.hasOwn(context, 'baseUrl')
}

function privacyProjection (dataRoot) {
  const browserWindowCount = BrowserWindow.getAllWindows().length
  const audioFileCount = countAudioFiles(dataRoot)
  if (browserWindowCount !== 0 || audioFileCount !== 0) throw new Error('privacy invariant')
  return {
    noBrowserWindowCreated: browserWindowCount === 0,
    browserWindowCount,
    reportContainsTranscriptText: false,
    reportContainsAbsolutePath: false,
    persistedAudio: audioFileCount !== 0,
    audioFileCount
  }
}

function assertChecks (checks, onFailure) {
  const failed = Object.entries(checks).find(([, value]) => value !== true)
  if (!failed) return
  if (typeof onFailure === 'function') onFailure(failed[0])
  throw new Error('journey assertion')
}

async function runInitialPhase ({ dataRoot, databasePath, configPath, providerBootstrap }) {
  let phase = 'initial-storage-start'
  let storageGateway = null
  let agentRuntime = null
  let coordinator = null
  let utility = null
  try {
    const storageGenerations = []
    const clock = { value: 10 }
    const configStore = new ConfigStore(configPath, { now: () => clock.value })
    configStore.load()
    configStore.applyPreset('meeting')

    storageGateway = createStorageGateway(databasePath, storageGenerations)
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

    phase = 'initial-invalid-policy'
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

    const recorder = new SqliteSessionRecorder({ gateway: storageGateway, now: () => clock.value })
    const persistenceSink = new MeetingStoppedPersistenceSink({ subtitleSink: recorder, agentRuntime })
    const adapter = new FakeRuntimeAdapter({ autoEmit: false })
    let sessionIndex = 0
    coordinator = new SessionCoordinator({
      adapter,
      runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
      configuration: configStore.get(),
      idFactory: () => TERMINAL_SESSION_IDS[sessionIndex++],
      persistenceSink
    })

    phase = 'initial-disabled-session'
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

    phase = 'initial-agent-settings'
    clock.value = 200
    const enabled = await agentRuntime.updateAgentSettings({
      expectedRevision: 0,
      agentEnabled: true,
      memoryEnabled: true,
      cloudDisclosureAccepted: true
    })

    phase = 'initial-meeting-stopped'
    clock.value = 210
    const readyStart = await coordinator.command('start')
    if (!readyStart.ok || coordinator.getSnapshot().sessionId !== READY_SESSION_ID) {
      throw new Error('ready session start invariant')
    }
    adapter.emitCaption(captionEvent(READY_SESSION_ID, 1, 'D12 synthetic committed transcript first'))
    adapter.emitCaption(captionEvent(READY_SESSION_ID, 2, 'D12 synthetic committed transcript second'))
    clock.value = 220
    const readyStop = await coordinator.command('stop')
    const stopReturnedBeforeNotification = readyStop.ok &&
      coordinator.getSnapshot().phase === 'idle' &&
      diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 0

    phase = 'initial-notification-worker-exit'
    const notificationHost = storageGateway.host
    const notificationChild = notificationHost?.child
    if (!notificationHost || notificationHost.state !== 'ready' || !notificationChild) {
      throw new Error('notification child unavailable')
    }
    const notificationExitPromise = notificationHost.waitForExactExit()
    const notificationTermination = notificationHost.terminateAndWait(10000)
    clock.value = 230
    const emptyStart = await coordinator.command('start')
    const notificationExitCode = await notificationTermination
    const notificationJoinedExitCode = await notificationExitPromise
    await agentRuntime.whenIdle()
    const notificationFailureChildReaped = notificationExitCode !== null &&
      notificationExitCode === notificationJoinedExitCode &&
      notificationHost.terminationChild === notificationChild &&
      notificationHost.child === null && notificationHost.state === 'stopped'
    const nextSessionStartedBeforeNotificationRecovery = emptyStart.ok &&
      coordinator.getSnapshot().sessionId === EMPTY_SESSION_ID
    const notificationFailureObserved =
      diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 1 &&
      agentRuntime.isTaskPolicyReady() === false && agentRuntime.getTaskPolicyRevision() === null

    phase = 'initial-first-replacement-policy-gate'
    const firstBlockedBeforePolicy = await storageGateway.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-first-claim-before-policy',
      owner: 'formal-agent-utility-first-replacement',
      leaseMs: 5000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })
    const notificationFailureRecovery = await agentRuntime.recoverTerminalSessions({
      sessionIds: [READY_SESSION_ID]
    })
    const firstRepeatedMeetingStopped = agentRuntime.notifyMeetingStopped({ sessionId: READY_SESSION_ID })
    const duplicateMeetingStopped = agentRuntime.notifyMeetingStopped({ sessionId: READY_SESSION_ID })
    await agentRuntime.whenIdle()

    clock.value = 240
    const emptyStop = await coordinator.command('stop')
    await waitForMeetingStopped(agentRuntime)

    phase = 'initial-claim-before-storage-exit'
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

    phase = 'initial-second-storage-exit'
    const claimedJobHost = storageGateway.host
    const exactChild = claimedJobHost?.child
    if (!claimedJobHost || claimedJobHost.state !== 'ready' || !exactChild) {
      throw new Error('exact child unavailable')
    }
    const exactExitPromise = claimedJobHost.waitForExactExit()
    const terminationExitCode = await claimedJobHost.terminateAndWait(10000)
    const joinedExitCode = await exactExitPromise
    const exactChildReaped = terminationExitCode !== null && terminationExitCode === joinedExitCode &&
      claimedJobHost.terminationChild === exactChild && claimedJobHost.child === null &&
      claimedJobHost.state === 'stopped'

    phase = 'initial-second-replacement-policy-gate'
    const blockedBeforePolicy = await storageGateway.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-claim-before-policy',
      owner: 'formal-agent-utility-replacement',
      leaseMs: 5000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })
    const recoveredSessions = await agentRuntime.recoverTerminalSessions({
      sessionIds: TERMINAL_SESSION_IDS
    })
    const recoveryBySession = Object.fromEntries(
      recoveredSessions.sessions.map((session) => [session.sessionId, session])
    )

    phase = 'initial-agent-utility-start'
    utility = await createAgentUtility({
      storage: storageGateway,
      providerBootstrap,
      scenario: 'exit-after-provider-result'
    })
    const availableBeforeExit = utility.pluginProxy.availableTaskKinds()
    const utilityChild = utility.workerHost.child
    const utilityExitPromise = utility.workerHost.waitForExactExit()
    const runner = createRunner(storageGateway, utility.pluginProxy)
    const waitMs = Math.max(0, claimedBeforeExit.lease.expiresAt - Date.now() + 30)
    if (waitMs > 2000) throw new Error('lease wait invariant')
    await sleep(waitMs)
    phase = 'initial-agent-utility-run'
    let utilityExitResult
    try {
      utilityExitResult = await runner.runNext({
        claimIdempotencyKey: 'formal-agent-utility-initial-recovery-claim',
        localWorkAllowed: false
      })
    } catch (error) {
      phase = 'initial-agent-utility-run-rejected'
      throw error
    }
    phase = 'initial-agent-utility-exact-exit'
    const utilityExitCode = await utilityExitPromise
    const utilityOutput = await utility.output.snapshot()
    phase = 'initial-agent-utility-same-process-gate'
    const sameProcessClaim = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-same-process-claim',
      localWorkAllowed: false
    })

    phase = 'initial-authority-readback'
    const detail = await storageGateway.getAgentSessionDetail({
      sessionId: READY_SESSION_ID,
      eligibilityContext: agentRuntime.getEligibilityContext()
    })
    const stats = await storageGateway.getStats()
    const meetingJob = detail.jobs.find((job) => job.taskKind === 'meeting-minutes')
    const currentRunIds = detail.jobs.map((job) => job.runId)
    const checks = {
      threeJobsReconciled: reconciledDetail.jobs.length === 3 &&
        reconciledDetail.jobs.every((job) => job.sessionId === READY_SESSION_ID &&
          job.providerId === 'deepseek' && job.providerKind === 'cloud' &&
          job.model === 'deepseek-v4-flash') &&
        new Set(reconciledDetail.jobs.map((job) => JSON.stringify(job.inputRef))).size === 1,
      meetingStoppedDetached: disabledStop.ok && emptyStop.ok && stopReturnedBeforeNotification,
      nextSessionStartedBeforeNotificationRecovery,
      disabledAndEmptySessionsSkipped:
        recoveryBySession[DISABLED_SESSION_ID]?.eligibility === 'outside_automatic_window' &&
        recoveryBySession[DISABLED_SESSION_ID]?.jobCount === 0 &&
        recoveryBySession[EMPTY_SESSION_ID]?.eligibility === 'no_committed_transcript' &&
        recoveryBySession[EMPTY_SESSION_ID]?.jobCount === 0,
      duplicateMeetingStoppedCoalesced: firstRepeatedMeetingStopped.accepted === true &&
        firstRepeatedMeetingStopped.coalesced === false &&
        duplicateMeetingStopped.accepted === true && duplicateMeetingStopped.coalesced === true,
      invalidPolicyFailsClosed,
      notificationFailureDeferred: notificationFailureObserved &&
        diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_TASK_POLICY_APPLY_FAILED').length === 1 &&
        diagnostics.filter((diagnostic) => diagnostic?.code === 'AGENT_RECONCILE_FAILED').length === 1 &&
        notificationFailureRecovery.sessions[0]?.createdJobCount === 3,
      notificationFailureChildReaped,
      exactChildReaped,
      replacementBlockedBeforePolicy: firstBlockedBeforePolicy === null && blockedBeforePolicy === null,
      taskPolicyReplayedBeforeUtility: initialRecovery.sessions.length === 0 &&
        restoredInitialPolicy.sessions.length === 0 && enabled.settings.agentSettingsRevision === 1 &&
        agentRuntime.isTaskPolicyReady() && agentRuntime.getTaskPolicyRevision() === 1,
      agentUtilityTaskClosureExact: JSON.stringify(availableBeforeExit) === JSON.stringify(TASK_KINDS),
      agentUtilityProviderResultObserved: utilityOutput.markerCount === 1 && utilityOutput.exact,
      agentUtilityExitChildReaped: utilityExitCode === 86 && utility.workerHost.child === null &&
        utility.workerHost.state === 'failed' && utilityChild !== null,
      utilityExitRetriedSameRun: utilityExitResult?.runId === claimedBeforeExit.runId &&
        utilityExitResult?.jobState === 'retry_wait' && meetingJob?.runId === claimedBeforeExit.runId &&
        meetingJob?.attemptCount === 2 && meetingJob?.errorCode === 'AGENT_WORKER_EXITED',
      credentialInvalidated: providerBootstrap.getPublicState().credentialState === 'invalid' &&
        providerBootstrap.getEligibilityProviderFacts().credentialAvailable === false,
      sameProcessClaimBlocked: sameProcessClaim === null && utility.workerHost.generation === 1,
      noPartialArtifact: detail.artifacts.length === 0 &&
        detail.jobs.filter((job) => job.state === 'succeeded').length === 0,
      taskIdentityStable: JSON.stringify([...originalRunIds].sort()) ===
        JSON.stringify([...currentRunIds].sort()),
      eligibilityContextExact: exactEligibilityContext(context),
      captionFactsPreserved: stats.sessions === 3 && stats.activeSessions === 0 &&
        stats.captionEvents === 3 && stats.segments === 3 && stats.integrity === 'ok'
    }
    assertChecks(checks, (name) => { phase = `initial-check-${name}` })

    phase = 'initial-graceful-storage-shutdown'
    utility.pluginProxy.dispose()
    const finalStorageHost = storageGateway.host
    await coordinator.dispose()
    coordinator = null
    agentRuntime.dispose()
    agentRuntime = null
    await storageGateway.shutdown()
    const gracefulStorageExit = storageGateway.host === null &&
      finalStorageHost?.child === null && finalStorageHost?.state === 'closed'
    storageGateway = null
    if (!gracefulStorageExit) throw new Error('storage shutdown invariant')
    providerBootstrap.dispose()

    return {
      schemaVersion: 1,
      kind: REPORT_KIND,
      phase: 'initial',
      result: 'pass',
      checks: { ...checks, gracefulStorageExit },
      metrics: {
        storageGenerationCount: storageGenerations.length,
        agentUtilityGenerationCount: utility.workerHost.generation,
        jobCount: detail.jobs.length,
        artifactCount: detail.artifacts.length,
        memoryCommitCount: 0,
        providerResultCount: utilityOutput.markerCount,
        recoveredAttemptCount: meetingJob.attemptCount
      },
      identityHash: identityHash(reconciledDetail.jobs[0].inputRef, originalRunIds),
      scope: {
        storageUtilityProcess: true,
        agentUtilityProcess: true,
        meetingStoppedWiring: true,
        meetingStoppedStorageGatewayWiring: true,
        agentJobRunnerStorageGatewayWiring: true,
        preloadIpcRenderer: false,
        packagedRuntime: false
      },
      privacy: privacyProjection(dataRoot)
    }
  } catch (error) {
    if (utility?.pluginProxy) utility.pluginProxy.dispose()
    await terminateQuietly(utility?.workerHost)
    if (agentRuntime) agentRuntime.dispose()
    if (coordinator) await coordinator.dispose().catch(() => {})
    await terminateQuietly(storageGateway)
    providerBootstrap.dispose()
    error.failurePhase = phase
    throw error
  }
}

async function runRecoveryPhase ({ dataRoot, databasePath, configPath, providerBootstrap }) {
  let phase = 'recovery-storage-start'
  let storageGateway = null
  let agentRuntime = null
  let utility = null
  try {
    const storageGenerations = []
    const configStore = new ConfigStore(configPath)
    const loadedConfig = configStore.load()
    storageGateway = createStorageGateway(databasePath, storageGenerations)
    await storageGateway.start()
    agentRuntime = new FormalAgentRuntime({
      storage: storageGateway,
      configStore,
      providerBootstrap,
      getLocalModelReady: () => false
    })

    phase = 'recovery-task-policy'
    const recoveredSessions = await agentRuntime.recoverTerminalSessions({
      sessionIds: TERMINAL_SESSION_IDS
    })
    const initialPolicyReady = agentRuntime.isTaskPolicyReady()
    const context = agentRuntime.getEligibilityContext()
    const beforeDetail = await storageGateway.getAgentSessionDetail({
      sessionId: READY_SESSION_ID,
      eligibilityContext: context
    })
    const originalRunIds = beforeDetail.jobs.map((job) => job.runId)
    const meetingBefore = beforeDetail.jobs.find((job) => job.taskKind === 'meeting-minutes')

    phase = 'recovery-agent-utility-start'
    utility = await createAgentUtility({
      storage: storageGateway,
      providerBootstrap,
      scenario: 'happy'
    })
    let runnerCommitReplacement = null
    let injectStorageExit = true
    const failureInjectingProxy = {
      availableTaskKinds: () => utility.pluginProxy.availableTaskKinds(),
      assertJobAvailable: (job) => utility.pluginProxy.assertJobAvailable(job),
      executeJob: async (job, options) => {
        const result = await utility.pluginProxy.executeJob(job, options)
        if (injectStorageExit && job.runId === meetingBefore.runId) {
          injectStorageExit = false
          const host = storageGateway.host
          const child = host?.child
          if (!host || host.state !== 'ready' || !child) {
            throw new Error('runner commit replacement child unavailable')
          }
          const exactExitPromise = host.waitForExactExit()
          const terminationExitCode = await host.terminateAndWait(10000)
          const joinedExitCode = await exactExitPromise
          runnerCommitReplacement = { host, child, terminationExitCode, joinedExitCode }
        }
        return result
      }
    }
    const runner = createRunner(storageGateway, failureInjectingProxy)
    const retryWaitMs = Math.max(0, meetingBefore.nextAttemptAt - Date.now() + 30)
    if (retryWaitMs > 2000) throw new Error('recovery retry wait invariant')
    await sleep(retryWaitMs)
    const taskKindByRunId = new Map(beforeDetail.jobs.map((job) => [job.runId, job.taskKind]))
    let recovered = null
    let memory = null
    let enhanced = null
    const recordResult = (result) => {
      const taskKind = taskKindByRunId.get(result?.runId)
      if (taskKind === 'meeting-minutes') recovered = result
      else if (taskKind === 'memory-extraction') memory = result
      else if (taskKind === 'enhanced-transcript') enhanced = result
      else throw new Error('recovered task identity invariant')
    }
    for (let index = 0; index < 3 && recovered === null; index += 1) {
      const result = await runner.runNext({
        claimIdempotencyKey: `formal-agent-utility-new-main-recovery-${index}`,
        localWorkAllowed: false
      })
      if (!result) throw new Error('recovery claim invariant')
      recordResult(result)
    }

    phase = 'recovery-storage-policy-gate'
    const replacementHost = storageGateway.host
    const replacementPolicyReadyBeforeRecovery = agentRuntime.isTaskPolicyReady()
    const replacementBlocked = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-new-main-before-policy',
      localWorkAllowed: false
    })
    const replacementRecovery = await agentRuntime.recoverTerminalSessions({
      sessionIds: TERMINAL_SESSION_IDS
    })
    for (let index = 0; index < 2 && (!memory || !enhanced); index += 1) {
      const result = await runner.runNext({
        claimIdempotencyKey: `formal-agent-utility-after-policy-${index}`,
        localWorkAllowed: false
      })
      if (!result) throw new Error('remaining task claim invariant')
      recordResult(result)
    }
    const empty = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-empty-claim',
      localWorkAllowed: false
    })

    phase = 'recovery-memory-read'
    const memoryProjection = await new MemoryReader(storageGateway).query({
      scopeRefs: [{ kind: 'session', canonicalKey: READY_SESSION_ID }],
      kinds: ['decision'],
      semanticKeys: ['decision:formal-agent-utility'],
      maxItems: 4,
      maxSerializedBytes: 16384
    })

    phase = 'recovery-session-detail-readback'
    const detail = await storageGateway.getAgentSessionDetail({
      sessionId: READY_SESSION_ID,
      eligibilityContext: agentRuntime.getEligibilityContext()
    })
    phase = 'recovery-storage-stats-readback'
    const stats = await storageGateway.getStats()
    const currentRunIds = detail.jobs.map((job) => job.runId)
    const meetingJob = detail.jobs.find((job) => job.taskKind === 'meeting-minutes')
    const artifactTypes = detail.artifacts.map((artifact) => artifact.type).sort()
    const utilityOutputBeforeShutdown = utility.output
    phase = 'recovery-checks'
    if (runnerCommitReplacement === null) throw new Error('missing storage replacement observation')
    if (replacementHost === runnerCommitReplacement.host) {
      phase = 'recovery-storage-host-not-replaced'
      throw new Error('storage host replacement invariant')
    }
    if (recovered?.jobState !== 'succeeded') {
      phase = 'recovery-first-job-not-succeeded'
      throw new Error('first recovered job invariant')
    }
    if (recovered?.runId !== meetingBefore?.runId) {
      phase = 'recovery-first-job-not-original-run'
      throw new Error('first recovered identity invariant')
    }
    const checks = {
      freshStartupCredentialAvailable: providerBootstrap.getPublicState().credentialState === 'startup_environment' &&
        providerBootstrap.getEligibilityProviderFacts().credentialAvailable === true &&
        loadedConfig.agentEnabled === true && loadedConfig.agentSettingsRevision === 1,
      taskPolicyReplayedBeforeRecovery: recoveredSessions.sessions.length === 3 &&
        initialPolicyReady === true,
      runnerCommitReplacementChildReaped: runnerCommitReplacement !== null &&
        runnerCommitReplacement.terminationExitCode !== null &&
        runnerCommitReplacement.terminationExitCode === runnerCommitReplacement.joinedExitCode &&
        runnerCommitReplacement.host.terminationChild === runnerCommitReplacement.child &&
        runnerCommitReplacement.host.child === null && runnerCommitReplacement.host.state === 'stopped',
      runnerCommitReplayedThroughGateway: runnerCommitReplacement !== null &&
        replacementHost !== runnerCommitReplacement.host &&
        recovered?.runId === meetingBefore?.runId && recovered?.jobState === 'succeeded',
      runnerReplacementBlockedBeforePolicy: replacementPolicyReadyBeforeRecovery === false &&
        replacementBlocked === null && replacementRecovery.sessions.length === 3,
      sameRunRecovered: recovered?.runId === meetingBefore?.runId &&
        meetingJob?.runId === meetingBefore?.runId && meetingJob?.attemptCount === 3,
      taskIdentityStable: JSON.stringify([...originalRunIds].sort()) ===
        JSON.stringify([...currentRunIds].sort()),
      independentResultsCommitted: memory?.jobState === 'succeeded' &&
        memory?.memory?.acceptedCandidateCount === 1 &&
        enhanced?.jobState === 'succeeded' && enhanced?.artifact?.type === 'enhanced-transcript',
      memoryReadThroughGateway: memoryProjection.availability === 'ready' &&
        memoryProjection.reason === null && memoryProjection.items.length === 1 &&
        memoryProjection.items[0].semanticKey === 'decision:formal-agent-utility' &&
        memoryProjection.itemCount === 1 && memoryProjection.hasMore === false,
      noDuplicateClaims: empty === null && detail.jobs.length === 3 &&
        detail.jobs.every((job) => job.state === 'succeeded'),
      artifactProjectionExact: detail.artifacts.length === 2 &&
        JSON.stringify(artifactTypes) === JSON.stringify(['enhanced-transcript', 'meeting-minutes']),
      agentUtilityTaskClosureExact: JSON.stringify(utility.pluginProxy.availableTaskKinds()) ===
        JSON.stringify(TASK_KINDS),
      eligibilityContextExact: exactEligibilityContext(context),
      captionFactsPreserved: stats.sessions === 3 && stats.activeSessions === 0 &&
        stats.captionEvents === 3 && stats.segments === 3 && stats.integrity === 'ok'
    }
    assertChecks(checks, (name) => { phase = `recovery-check-${name}` })

    phase = 'recovery-graceful-shutdown'
    await utility.workerHost.shutdown()
    const utilityOutput = await utilityOutputBeforeShutdown.snapshot()
    const gracefulAgentUtilityExit = utility.workerHost.child === null &&
      utility.workerHost.state === 'closed' && utilityOutput.markerCount === 3 && utilityOutput.exact
    utility.pluginProxy.dispose()
    const finalStorageHost = storageGateway.host
    agentRuntime.dispose()
    agentRuntime = null
    await storageGateway.shutdown()
    const gracefulStorageExit = storageGateway.host === null &&
      finalStorageHost?.child === null && finalStorageHost?.state === 'closed'
    storageGateway = null
    if (!gracefulAgentUtilityExit || !gracefulStorageExit) throw new Error('shutdown invariant')
    providerBootstrap.dispose()

    return {
      schemaVersion: 1,
      kind: REPORT_KIND,
      phase: 'recovery',
      result: 'pass',
      checks: { ...checks, gracefulAgentUtilityExit, gracefulStorageExit },
      metrics: {
        storageGenerationCount: storageGenerations.length,
        agentUtilityGenerationCount: utility.workerHost.generation,
        jobCount: detail.jobs.length,
        artifactCount: detail.artifacts.length,
        memoryCommitCount: memory.memory.acceptedCandidateCount === 1 ? 1 : 0,
        providerResultCount: utilityOutput.markerCount,
        recoveredAttemptCount: meetingJob.attemptCount
      },
      identityHash: identityHash(beforeDetail.jobs[0].inputRef, originalRunIds),
      scope: {
        storageUtilityProcess: true,
        agentUtilityProcess: true,
        meetingStoppedWiring: true,
        meetingStoppedStorageGatewayWiring: true,
        agentJobRunnerStorageGatewayWiring: true,
        preloadIpcRenderer: false,
        packagedRuntime: false
      },
      privacy: privacyProjection(dataRoot)
    }
  } catch (error) {
    if (utility?.pluginProxy) utility.pluginProxy.dispose()
    await terminateQuietly(utility?.workerHost)
    if (agentRuntime) agentRuntime.dispose()
    await terminateQuietly(storageGateway)
    providerBootstrap.dispose()
    error.failurePhase = phase
    throw error
  }
}

async function main () {
  let journeyPhase = 'arguments'
  let providerBootstrap = null
  try {
    const parsed = parseArguments(process.argv)
    journeyPhase = parsed.journeyPhase
    providerBootstrap = new AgentProviderBootstrap({ environment: process.env })
    const userData = path.join(parsed.dataRoot, `electron-user-data-${journeyPhase}`)
    const dataDirectory = path.join(parsed.dataRoot, 'data')
    const databasePath = path.join(dataDirectory, 'speech-agent.sqlite3')
    const configPath = path.join(dataDirectory, 'config.json')
    fs.mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
    app.on('window-all-closed', () => {})
    await app.whenReady()

    const report = journeyPhase === 'initial'
      ? await runInitialPhase({
          dataRoot: parsed.dataRoot,
          databasePath,
          configPath,
          providerBootstrap
        })
      : await runRecoveryPhase({
          dataRoot: parsed.dataRoot,
          databasePath,
          configPath,
          providerBootstrap
        })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    app.exit(0)
  } catch (error) {
    if (providerBootstrap) providerBootstrap.dispose()
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: REPORT_KIND,
      phase: journeyPhase,
      result: 'fail',
      failurePhase: error?.failurePhase || journeyPhase
    })}\n`)
    app.exit(1)
  }
}

main().catch(() => app.exit(1))
