'use strict'

/* D6 确定性组合：Electron main → production StorageWorkerHost →
   storage utility process → StorageWorkerService → 正式 SQLite migration，
   再由正式 AgentPluginHost / ModelGateway / Pi Agent Loop / job runner 消费。
   只替代 Agent 模型 provider；不开 BrowserWindow，不启动字幕采集，不写报告文件。 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { AgentInputPlanner } = require('../src/agent-core/formal/input-planner')
const { AgentJobRunner } = require('../src/agent-core/formal/job-runner')
const { ModelGateway } = require('../src/agent-core/formal/model-gateway')
const { AgentPluginHost } = require('../src/agent-core/formal/plugin-host')
const { TranscriptReader } = require('../src/agent-core/formal/storage-ports')
const { AgentModelProviderRegistry } = require('../src/agent-provider/model-provider-registry')
const { AgentProviderBootstrap } = require('../src/agent-provider/provider-bootstrap')
const { StorageWorkerHost } = require('../src/runtime/storage-worker/worker-host')

const SESSION_ID = 'formal-agent-utility-session'
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

function eligibilityContext (providerFacts) {
  return {
    agentEnabled: true,
    memoryEnabled: true,
    automaticProcessingSince: 0,
    memoryProcessingSince: 0,
    ...providerFacts,
    cloudDisclosureAccepted: true,
    localModelReady: false
  }
}

function captionEvent (sequence, text) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    sourceId: 'loopback',
    segmentId: `formal-agent-utility-segment-${sequence}`,
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

class D6DeterministicProvider {
  constructor () {
    this.calls = []
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
    return { model: core.getModel(), streamFn: core.streamSimple }
  }
}

function createRuntime (storage, provider, bootstrap) {
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

function countAudioFiles (directory) {
  let count = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) count += countAudioFiles(path.join(directory, entry.name))
    else if (entry.isFile() && /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) count += 1
  }
  return count
}

async function terminateQuietly (host) {
  if (!host || host.child === null) return
  await host.terminateAndWait(5000).catch(() => {})
}

async function main () {
  let phase = 'arguments'
  let firstHost = null
  let replacementHost = null
  let providerBootstrap = null
  let providerRegistry = null
  try {
    const { dataRoot } = parseArguments(process.argv)
    const userData = path.join(dataRoot, 'electron-user-data')
    const databasePath = path.join(dataRoot, 'data', 'speech-agent.sqlite3')
    fs.mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
    app.on('window-all-closed', () => {})

    phase = 'provider-bootstrap'
    providerBootstrap = new AgentProviderBootstrap({ environment: process.env })

    phase = 'app-ready'
    await app.whenReady()

    phase = 'first-generation'
    firstHost = new StorageWorkerHost({ databasePath, requestTimeoutMs: 10000 })
    await firstHost.start()
    await firstHost.openSession({
      sessionId: SESSION_ID,
      sourceId: 'loopback',
      startedAt: 100,
      refinementEnabled: false
    })
    await firstHost.appendCaption(captionEvent(1, 'D6 synthetic committed transcript first'))
    await firstHost.appendCaption(captionEvent(2, 'D6 synthetic committed transcript second'))
    await firstHost.closeSession({
      sessionId: SESSION_ID,
      sourceId: 'loopback',
      endedAt: 200,
      state: 'closed'
    })

    phase = 'reconcile-and-claim'
    const context = eligibilityContext(providerBootstrap.getEligibilityProviderFacts())
    const reconciled = await firstHost.reconcileTerminalAgentSession({
      sessionId: SESSION_ID,
      requestedBy: 'automatic',
      eligibilityContext: context
    })
    await firstHost.applyAgentTaskPolicy({ eligibilityContext: context })
    const claimedBeforeExit = await firstHost.claimNextAgentJob({
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
    const exactChild = firstHost.child
    if (firstHost.state !== 'ready' || !exactChild) throw new Error('exact child unavailable')
    const exactExitPromise = firstHost.waitForExactExit()
    const terminationExitCode = await firstHost.terminateAndWait(10000)
    const joinedExitCode = await exactExitPromise
    const exactChildReaped = terminationExitCode !== null &&
      terminationExitCode === joinedExitCode &&
      firstHost.terminationChild === exactChild &&
      firstHost.child === null &&
      firstHost.state === 'stopped'

    phase = 'replacement-before-policy'
    replacementHost = new StorageWorkerHost({ databasePath, requestTimeoutMs: 10000 })
    await replacementHost.start()
    const blockedBeforePolicy = await replacementHost.claimNextAgentJob({
      claimIdempotencyKey: 'formal-agent-utility-claim-before-policy',
      owner: 'formal-agent-utility-replacement',
      leaseMs: 5000,
      localWorkAllowed: false,
      availableTaskKinds: TASK_KINDS
    })
    const replayedReconciliation = await replacementHost.reconcileTerminalAgentSession({
      sessionId: SESSION_ID,
      requestedBy: 'automatic',
      eligibilityContext: context
    })

    phase = 'replacement-policy'
    await replacementHost.applyAgentTaskPolicy({ eligibilityContext: context })
    const provider = new D6DeterministicProvider()
    const runtime = createRuntime(replacementHost, provider, providerBootstrap)
    const { pluginHost, runner } = runtime
    providerRegistry = runtime.providerRegistry
    const waitMs = Math.max(0, claimedBeforeExit.lease.expiresAt - Date.now() + 30)
    if (waitMs > 2000) throw new Error('lease wait invariant')
    await sleep(waitMs)

    phase = 'same-run-recovery'
    const recovered = await runner.runNext({
      claimIdempotencyKey: 'formal-agent-utility-recovery-claim',
      localWorkAllowed: false
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

    phase = 'authority-readback'
    const detail = await replacementHost.getAgentSessionDetail({
      sessionId: SESSION_ID,
      eligibilityContext: context
    })
    const stats = await replacementHost.getStats()
    const originalRunIds = reconciled.jobs.map((entry) => entry.job.runId)
    const currentRunIds = detail.jobs.map((job) => job.runId)
    const recoveredJob = detail.jobs.find((job) => job.runId === claimedBeforeExit.runId)
    const artifactTypes = detail.artifacts.map((artifact) => artifact.type).sort()
    const checks = {
      threeJobsReconciled: reconciled.eligibility === 'ready' && reconciled.jobs.length === 3 &&
        reconciled.jobs.every((entry) => entry.status === 'created'),
      exactChildReaped,
      replacementBlockedBeforePolicy: blockedBeforePolicy === null,
      duplicateReconciliationIdempotent: replayedReconciliation.jobs.length === 3 &&
        replayedReconciliation.jobs.every((entry) => entry.status === 'already_processed'),
      sameRunRecovered: recovered?.runId === claimedBeforeExit.runId && recovered?.jobState === 'succeeded' &&
        recoveredJob?.attemptCount === 2,
      taskIdentityStable: JSON.stringify([...originalRunIds].sort()) === JSON.stringify([...currentRunIds].sort()),
      independentResultsCommitted: memory?.jobState === 'succeeded' && memory?.memory?.acceptedCandidateCount === 1 &&
        enhanced?.jobState === 'succeeded' && enhanced?.artifact?.type === 'enhanced-transcript',
      noDuplicateClaims: empty === null && detail.jobs.length === 3 &&
        detail.jobs.every((job) => job.state === 'succeeded'),
      artifactProjectionExact: detail.artifacts.length === 2 &&
        JSON.stringify(artifactTypes) === JSON.stringify(['enhanced-transcript', 'meeting-minutes']),
      pluginTaskClosureExact: JSON.stringify(pluginHost.availableTaskKinds()) === JSON.stringify(TASK_KINDS),
      captionFactsPreserved: stats.sessions === 1 && stats.activeSessions === 0 &&
        stats.captionEvents === 2 && stats.segments === 2 && stats.integrity === 'ok'
    }
    const failedChecks = Object.entries(checks)
      .filter(([, value]) => value !== true)
      .map(([name]) => name)
    if (failedChecks.length !== 0) throw new Error('journey assertion')

    phase = 'graceful-shutdown'
    await replacementHost.shutdown()
    const gracefulExactExit = replacementHost.child === null && replacementHost.state === 'closed'
    if (!gracefulExactExit) throw new Error('shutdown invariant')
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
        storageGenerationCount: 2,
        jobCount: detail.jobs.length,
        artifactCount: detail.artifacts.length,
        memoryCommitCount: memory.memory.acceptedCandidateCount === 1 ? 1 : 0,
        providerCallCount: provider.calls.length,
        recoveredAttemptCount: recoveredJob.attemptCount
      },
      identityHash: identityHash(reconciled.inputRef, originalRunIds),
      scope: {
        storageUtilityProcess: true,
        agentUtilityProcess: false,
        meetingStoppedWiring: false,
        storageGatewayWiring: false,
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
    if (providerRegistry) providerRegistry.dispose()
    else if (providerBootstrap) providerBootstrap.dispose()
    await terminateQuietly(replacementHost)
    await terminateQuietly(firstHost)
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
