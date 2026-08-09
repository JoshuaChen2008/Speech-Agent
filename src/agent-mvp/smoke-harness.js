'use strict'

const REPORT_SCHEMA_VERSION = 2

const RENDERER_HELPERS = `
  const waitFor = async (predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw Object.assign(new Error('smoke timeout'), { code: 'AGENT_PROVIDER_TIMEOUT' })
  }
  const assertSmoke = (value) => {
    if (!value) throw Object.assign(new Error('smoke assertion'), { code: 'AGENT_INTERNAL_FAILURE' })
  }
  const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]')
  const clickAndSettle = async (element) => {
    assertSmoke(element)
    element.click()
    await new Promise((resolve) => setTimeout(resolve, 25))
    await waitFor(() => !element.isConnected || !element.disabled)
  }
  const stateNow = () => window.agentMvp.getState()
  const jobNow = async (runId) => (await stateNow()).runtime.jobs.find((job) => job.runId === runId) || null
  const waitJob = (runId, predicate) => waitFor(async () => {
    const job = await jobNow(runId)
    return job && predicate(job) ? job : null
  })
  const sha256 = async (value) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const identityHash = async (jobs) => jobs.length === 0 ? null : sha256(jobs.map((job) => job.runId).sort().join('\\n'))
  const makeReport = async ({ scenario, phase, toolEventCount = null, rendererReloaded = false, agentUtilityReplaced = false, storageUtilityPreserved = false }) => {
    const state = await stateNow()
    const jobs = state.runtime.jobs
    return {
      schemaVersion: ${REPORT_SCHEMA_VERSION},
      result: 'pass',
      scenario,
      phase,
      sessionCount: state.runtime.sessions.length,
      messageCount: document.querySelectorAll('[data-testid="message-item"]').length,
      jobCount: jobs.length,
      artifactCount: state.runtime.artifacts.length,
      toolEventCount: toolEventCount === null ? document.querySelectorAll('[data-testid="tool-event"]').length : toolEventCount,
      attemptCount: jobs.reduce((total, job) => total + job.attemptCount, 0),
      succeededCount: jobs.filter((job) => job.state === 'succeeded').length,
      failedCount: jobs.filter((job) => job.state === 'failed').length,
      cancelledCount: jobs.filter((job) => job.state === 'cancelled').length,
      identityHash: await identityHash(jobs),
      credentialAvailable: state.provider.hasCredential === true,
      credentialPersisted: state.provider.credentialPersisted === true,
      rendererReloaded,
      agentUtilityReplaced,
      storageUtilityPreserved,
      transcriptInReport: false,
      audioPersisted: false,
      credentialInReport: false,
      internalThoughtInReport: false,
      localPathInReport: false
    }
  }
  const waitForRenderer = async () => {
    await waitFor(() => byTestId('provider-type'))
  }
  const createFixture = async () => {
    await clickAndSettle(byTestId('fixture-loopback'))
    await waitFor(() => byTestId('session-item'))
    await waitFor(() => byTestId('preview-reference') && !byTestId('preview-reference').disabled)
  }
  const acceptPreview = async () => {
    const before = new Set((await stateNow()).runtime.jobs.map((job) => job.runId))
    await clickAndSettle(byTestId('preview-reference'))
    await waitFor(() => byTestId('preview-panel'))
    const previewId = await waitFor(async () => {
      const state = await stateNow()
      const session = state.runtime.sessions[0]
      if (!session) return null
      const messages = await window.agentMvp.messages(session.sessionId)
      const message = [...messages.messages].reverse().find((entry) => entry.role === 'tool_preview')
      return message?.content?.previewId || null
    })
    window.__agentMvpLastPreviewId = previewId
    byTestId('preview-accept').click()
    await waitFor(() => !byTestId('preview-panel'))
    return waitFor(async () => (await stateNow()).runtime.jobs.find((job) => !before.has(job.runId)) || null)
  }
  const cancelVisibleJob = async (state, runId) => {
    const runsTab = document.querySelector('[role="tab"][aria-controls="viewRuns"]')
    if (runsTab && runsTab.getAttribute('aria-selected') !== 'true') {
      runsTab.click()
      await waitFor(() => runsTab.getAttribute('aria-selected') === 'true')
    }
    const card = await waitFor(() => document.querySelector('[data-testid="job-item"][data-state="' + state + '"]'))
    const nested = card.querySelector('button')
    if (nested) {
      window.__agentMvpSmokeStep = 'cancel-visible-nested-button'
      await waitFor(() => !nested.disabled)
      nested.click()
    }
    else {
      window.__agentMvpSmokeStep = 'cancel-visible-detail-button'
      card.click()
      await waitFor(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) => ['取消', '取消这个任务'].includes((candidate.textContent || '').trim()) && !candidate.disabled && candidate.isConnected)
        if (!button) return false
        window.__agentMvpSmokeStep = 'cancel-visible-detail-clicked'
        button.click()
        return true
      })
    }
    await waitFor(async () => {
      const job = await jobNow(runId)
      return job && job.cancelRequestedAt !== null
    }, 3000)
  }
`

function execute (window, body) {
  return window.webContents.executeJavaScript(`(async () => {${RENDERER_HELPERS}${body}})()`)
}

async function reloadRenderer (window) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Object.assign(new Error('renderer reload timeout'), { code: 'AGENT_PROVIDER_TIMEOUT' })), 10000)
    const done = () => { clearTimeout(timeout); resolve() }
    window.webContents.once('did-finish-load', done)
    window.webContents.reload()
  })
}

function runHappy (window, phase, smokeCredential) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'happy-${phase}'
    await waitForRenderer()
    if (${JSON.stringify(phase)} === 'first') {
      window.__agentMvpSmokeStep = 'happy-provider-cloud'
      const cloudState = await window.agentMvp.saveProvider({
        provider: 'openai-compatible', baseUrl: 'https://provider.invalid/v1', model: 'journey-model',
        cloudDisclosureAccepted: true, apiKey: ${JSON.stringify(smokeCredential)}
      })
      assertSmoke(cloudState.hasCredential === true)
      await window.agentMvp.saveProvider({
        provider: 'deterministic-test', baseUrl: '', model: 'fixture-model', cloudDisclosureAccepted: false, apiKey: ''
      })
      window.__agentMvpSmokeStep = 'happy-fixture'
      await createFixture()
      await waitFor(() => byTestId('chat-send') && !byTestId('chat-send').disabled)
      window.__agentMvpSmokeStep = 'happy-chat'
      await clickAndSettle(byTestId('chat-send'))
      await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 2)
      window.__agentMvpSmokeStep = 'happy-reference'
      const job = await acceptPreview()
      await waitJob(job.runId, (value) => value.state === 'succeeded')
      await waitFor(() => byTestId('artifact-item'))
      await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 5)
    } else {
      await waitFor(async () => (await stateNow()).runtime.sessions.length === 1)
      await waitFor(async () => (await stateNow()).runtime.jobs.some((job) => job.state === 'succeeded'))
      await waitFor(() => byTestId('artifact-item'))
      await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 5)
    }
    return makeReport({ scenario: 'happy-restart', phase: ${JSON.stringify(phase)} })
  `)
}

function runBoundarySetup (window) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'boundary-setup'
    await waitForRenderer()
    await createFixture()

    window.__agentMvpSmokeStep = 'boundary-reject'
    await clickAndSettle(byTestId('preview-reference'))
    await waitFor(() => byTestId('preview-panel'))
    byTestId('preview-reject').click()
    await waitFor(() => !byTestId('preview-panel'))
    assertSmoke((await stateNow()).runtime.jobs.length === 0)

    window.__agentMvpSmokeStep = 'boundary-queued-cancel'
    const queued = await acceptPreview()
    await waitJob(queued.runId, (job) => job.state === 'queued')
    await cancelVisibleJob('queued', queued.runId)
    await waitJob(queued.runId, (job) => job.state === 'cancelled' && job.errorCode === null)
    assertSmoke((await stateNow()).runtime.artifacts.length === 0)
    await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 4)
    return makeReport({ scenario: 'boundary-matrix', phase: 'setup' })
  `)
}

function runBoundaryMatrix (window) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'boundary-matrix'
    await waitForRenderer()
    window.__agentMvpSmokeStep = 'boundary-claim-cancel-create'
    const referenceRunsBeforeClaimCancel = (await stateNow()).runtime.referenceRunCount
    const claimed = await acceptPreview()
    await waitJob(claimed.runId, (job) => job.state === 'running')
    window.__agentMvpSmokeStep = 'boundary-claim-cancel-ipc'
    await window.agentMvp.cancel(claimed.runId)
    await waitJob(claimed.runId, (job) => job.state === 'cancelled' && job.errorCode === null)
    assertSmoke((await stateNow()).runtime.referenceRunCount === referenceRunsBeforeClaimCancel)
    assertSmoke(!(await stateNow()).runtime.artifacts.some((artifact) => artifact.runId === claimed.runId))

    const transient = async (errorCode, step) => {
      window.__agentMvpSmokeStep = step
      const created = await acceptPreview()
      const waiting = await waitJob(created.runId, (job) => job.state === 'retry_wait')
      assertSmoke(waiting.errorCode === errorCode && waiting.attemptCount === 1)
      const terminal = await waitJob(created.runId, (job) => job.state === 'succeeded')
      assertSmoke(terminal.runId === created.runId && terminal.attemptCount === 2)
      return terminal
    }
    const terminal = async (errorCode, step, expectedTool = null) => {
      window.__agentMvpSmokeStep = step
      let deniedToolObserved = false
      const unsubscribeDeniedTool = expectedTool ? window.agentMvp.onEvent((entry) => {
        if (entry?.event?.type === 'tool_execution_end' && entry.event.toolName === expectedTool && entry.event.isError === true) deniedToolObserved = true
      }) : null
      const created = await acceptPreview()
      const failed = await waitJob(created.runId, (job) => job.state === 'failed')
      assertSmoke(failed.errorCode === errorCode && failed.attemptCount === 1)
      assertSmoke(!(await stateNow()).runtime.artifacts.some((artifact) => artifact.runId === created.runId))
      if (expectedTool) {
        await waitFor(() => deniedToolObserved)
        unsubscribeDeniedTool()
      }
      return failed
    }
    await transient('AGENT_PROVIDER_TIMEOUT', 'boundary-408')
    await transient('AGENT_PROVIDER_RATE_LIMITED', 'boundary-429')
    await transient('AGENT_PROVIDER_UNAVAILABLE', 'boundary-5xx')
    await terminal('AGENT_PROVIDER_AUTH_FAILED', 'boundary-auth')
    await terminal('AGENT_OUTPUT_INVALID', 'boundary-schema')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-shell', 'shell')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-process', 'process_spawn')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-filesystem', 'filesystem_write')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-network', 'network_fetch')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-sql', 'sql_query')
    await terminal('AGENT_PERMISSION_DENIED', 'boundary-permission-subagent', 'spawn_subagent')

    window.__agentMvpSmokeStep = 'boundary-running-cancel-create'
    const running = await acceptPreview()
    window.__agentMvpSmokeStep = 'boundary-running-cancel-wait'
    await waitJob(running.runId, (job) => job.state === 'running')
    window.__agentMvpSmokeStep = 'boundary-running-cancel-click'
    await cancelVisibleJob('running', running.runId)
    window.__agentMvpSmokeStep = 'boundary-running-cancel-terminal'
    await waitJob(running.runId, (job) => job.state === 'cancelled' && job.errorCode === null)
    window.__agentMvpSmokeStep = 'boundary-running-cancel-late-result'
    await new Promise((resolve) => setTimeout(resolve, 700))
    assertSmoke(!(await stateNow()).runtime.artifacts.some((artifact) => artifact.runId === running.runId))

    window.__agentMvpSmokeStep = 'boundary-rerun'
    await clickAndSettle(byTestId('preview-reference'))
    await waitFor(() => byTestId('preview-panel'))
    const replayPreviewId = await waitFor(async () => {
      const state = await stateNow()
      const messages = await window.agentMvp.messages(state.runtime.sessions[0].sessionId)
      return [...messages.messages].reverse().find((entry) => entry.role === 'tool_preview')?.content?.previewId || null
    })
    const jobsBeforeReplay = (await stateNow()).runtime.jobs.length
    const [firstReplay, duplicateReplay] = await Promise.all([
      window.agentMvp.confirm(replayPreviewId, 'accepted'),
      window.agentMvp.confirm(replayPreviewId, 'accepted')
    ])
    assertSmoke(firstReplay.runId === duplicateReplay.runId)
    assertSmoke((await stateNow()).runtime.jobs.length === jobsBeforeReplay + 1)
    byTestId('preview-accept').click()
    await waitFor(() => !byTestId('preview-panel'))
    const first = await waitJob(firstReplay.runId, (job) => job.state === 'succeeded')
    const second = await acceptPreview()
    await waitJob(second.runId, (job) => job.state === 'succeeded')
    assertSmoke(first.runId !== second.runId)

    const state = await stateNow()
    assertSmoke(state.runtime.jobs.length === 16)
    assertSmoke(state.runtime.artifacts.length === 5)
    assertSmoke(state.runtime.jobs.filter((job) => job.state === 'succeeded').length === 5)
    assertSmoke(state.runtime.jobs.filter((job) => job.state === 'failed').length === 8)
    assertSmoke(state.runtime.jobs.filter((job) => job.state === 'cancelled').length === 3)
    assertSmoke(state.runtime.referenceRunCount === 17)
    await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 39)
    assertSmoke(document.querySelectorAll('[data-testid="tool-event"]').length > 0)
    return makeReport({ scenario: 'boundary-matrix', phase: 'matrix' })
  `)
}

function runBoundaryReload (window, prior) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'boundary-reload'
    await waitForRenderer()
    await waitFor(async () => (await stateNow()).runtime.jobs.length === 16)
    await waitFor(async () => (await stateNow()).runtime.artifacts.length === 5)
    await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 39)
    const report = await makeReport({
      scenario: 'boundary-matrix', phase: 'reload', toolEventCount: ${Number(prior.toolEventCount)}, rendererReloaded: true
    })
    assertSmoke(report.identityHash === ${JSON.stringify(prior.identityHash)})
    return report
  `)
}

function runInterrupted (window, phase) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'interruption-${phase}'
    await waitForRenderer()
    if (${JSON.stringify(phase)} === 'interrupt') {
      await createFixture()
      const running = await acceptPreview()
      await waitJob(running.runId, (job) => job.state === 'running' && job.attemptCount === 1)
      await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 2)
    } else {
      await waitFor(async () => (await stateNow()).runtime.jobs.some((job) => job.state === 'succeeded' && job.attemptCount === 2))
      await waitFor(async () => (await stateNow()).runtime.artifacts.length === 1)
      await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 3)
    }
    return makeReport({ scenario: 'interruption-recovery', phase: ${JSON.stringify(phase)} })
  `)
}

function runWorkerSetup (window) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'worker-replacement-setup'
    await waitForRenderer()
    await createFixture()
    const running = await acceptPreview()
    await waitJob(running.runId, (job) => job.state === 'running' && job.attemptCount === 1)
    return makeReport({ scenario: 'worker-replacement', phase: 'running' })
  `)
}

function runWorkerRecovery (window) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'worker-replacement-recovery'
    await waitForRenderer()
    const waiting = await waitFor(async () => (await stateNow()).runtime.jobs.find((job) => job.state === 'retry_wait') || null)
    assertSmoke(waiting.errorCode === 'AGENT_WORKER_EXITED' && waiting.attemptCount === 1)
    await waitFor(async () => (await stateNow()).runtime.jobs.some((job) => job.state === 'succeeded' && job.attemptCount === 2))
    await waitFor(async () => (await stateNow()).runtime.artifacts.length === 1)
    await waitFor(() => document.querySelectorAll('[data-testid="message-item"]').length >= 3)
    return makeReport({ scenario: 'worker-replacement', phase: 'recovered' })
  `)
}

function runCredential (window, phase, smokeCredential) {
  return execute(window, `
    window.__agentMvpSmokeStep = 'credential-${phase}'
    await waitForRenderer()
    if (${JSON.stringify(phase)} === 'first') {
      const saved = await window.agentMvp.saveProvider({
        provider: 'openai-compatible', baseUrl: 'https://provider.invalid/v1', model: 'journey-model',
        cloudDisclosureAccepted: true, apiKey: ${JSON.stringify(smokeCredential)}
      })
      assertSmoke(saved.hasCredential === true && saved.credentialPersisted === false)
    } else {
      const state = await stateNow()
      assertSmoke(state.provider.hasCredential === false && state.provider.credentialPersisted === false)
    }
    return makeReport({ scenario: 'credential-session-only', phase: ${JSON.stringify(phase)} })
  `)
}

async function runSmokeScenario ({ window, runtime, scenario, phase, resumeClaims, smokeCredential }) {
  if (scenario === 'happy-restart') return runHappy(window, phase, smokeCredential)
  if (scenario === 'boundary-matrix') {
    await runBoundarySetup(window)
    resumeClaims()
    await runtime.drain()
    const prior = await runBoundaryMatrix(window)
    await reloadRenderer(window)
    return runBoundaryReload(window, prior)
  }
  if (scenario === 'interruption-recovery') return runInterrupted(window, phase)
  if (scenario === 'worker-replacement') {
    const before = await runWorkerSetup(window)
    const originalAgent = runtime.agent.child
    const originalStorage = runtime.storage.child
    if (!originalAgent || !originalAgent.kill()) throw Object.assign(new Error('worker termination failed'), { code: 'AGENT_WORKER_EXITED' })
    const report = await runWorkerRecovery(window)
    if (report.identityHash !== before.identityHash) throw Object.assign(new Error('worker run identity changed'), { code: 'AGENT_INTERNAL_FAILURE' })
    return { ...report, agentUtilityReplaced: runtime.agent.child !== null && runtime.agent.child !== originalAgent, storageUtilityPreserved: runtime.storage.child === originalStorage }
  }
  if (scenario === 'credential-session-only') return runCredential(window, phase, smokeCredential)
  throw Object.assign(new Error('unknown smoke scenario'), { code: 'AGENT_REQUEST_INVALID' })
}

module.exports = { REPORT_SCHEMA_VERSION, runSmokeScenario }
