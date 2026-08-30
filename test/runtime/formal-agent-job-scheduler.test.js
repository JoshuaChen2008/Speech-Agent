'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ContextIngestSessionRunner,
  FormalAgentJobScheduler,
  S1TerminalSessionReconciler
} = require('../../src/agent/execution-host')

function settled () {
  return new Promise((resolve) => setImmediate(resolve))
}

test('SEM-F28/SEM-F30/J21: scheduler starts once, owns one worker and drains fixed recipe jobs', async () => {
  const jobs = [{ runId: 'run.1' }, null]
  const claims = []
  const runs = []
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.1',
    storage: {
      claimNextFormalAgentRun: async (identity) => { claims.push(identity); return jobs.shift() },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async (job) => runs.push(job.runId) }
  })
  assert.equal(scheduler.start(), true)
  assert.equal(scheduler.start(), false)
  await settled()
  assert.deepEqual(runs, ['run.1'])
  assert.equal(new Set(claims.map((item) => item.owner)).size, 1)
  await scheduler.stop()
})

test('SEM-F28/SEM-F30/J21: S1 product qualification is fixed provider_not_configured with zero automatic writes', async () => {
  const reconciler = new S1TerminalSessionReconciler()
  assert.deepEqual(await reconciler.reconcile({ sessionId: 'session.terminal' }), {
    eligibility: 'provider_not_configured', createdRunCount: 0, createdReportCount: 0
  })
  await assert.rejects(reconciler.reconcile({ sessionId: 'session.terminal', ready: true }), TypeError)
})

test('SEM-F28/SEM-F30/J21: unknown claim outcome retries the exact logical claim identity', async () => {
  const identities = []
  const timers = []
  let attempts = 0
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.retry',
    storage: {
      claimNextFormalAgentRun: async (identity) => {
        identities.push(identity)
        attempts += 1
        if (attempts === 1) throw new Error('unknown transport result')
        return null
      },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async () => {} },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  assert.equal(timers[0].delay, 1000)
  timers[0].callback()
  await settled()
  assert.deepEqual(identities[1], identities[0])
  await scheduler.stop()
})

test('SEM-F28/SEM-F30/J21: wakeEpoch is rechecked before idle and earliest retry uses one invalidatable timer', async () => {
  let release
  let calls = 0
  const timers = []
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.epoch',
    now: () => 100,
    storage: {
      claimNextFormalAgentRun: async () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => { release = resolve })
        return null
      },
      nextFormalAgentRunAt: async () => 150
    },
    runner: { run: async () => {} },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  scheduler.wake('terminal-session')
  release(null)
  await settled()
  assert.equal(calls, 2, 'wake during claim must force another scan before idle')
  assert.equal(timers.at(-1).delay, 50)
  const staleTimer = timers.at(-1).callback
  await scheduler.stop()
  staleTimer()
  await settled()
  assert.equal(calls, 2, 'stopped generation must ignore its stale timer')
})

test('SEM-F28/SEM-F30/J21: scheduler diagnostics are stable and contain no exception material', async () => {
  const diagnostics = []
  const timers = []
  const scheduler = new FormalAgentJobScheduler({
    storage: {
      claimNextFormalAgentRun: async () => { throw new Error('C:\\private\\secret stack') },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async () => {} },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    setTimer: (callback) => { timers.push(callback); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  assert.deepEqual(diagnostics, [{ code: 'AGENT_SCHEDULER_FAILED' }])
  assert.equal(Object.keys(diagnostics[0]).length, 1)
  await scheduler.stop()
})

test('SEM-F28/SEM-F30/J21: context ingest runner settles one frozen attempt without exposing failures', async () => {
  const settlements = []
  const source = { sourceKind: 'session', sessionId: 'session.1' }
  const runner = new ContextIngestSessionRunner({
    personalContext: { ingest: async (value) => {
      assert.equal(value, source)
      return { episodeCount: 1, memoryCount: 0 }
    } },
    storage: {
      completeFormalAgentRun: async (value) => settlements.push(['complete', value]),
      failFormalAgentRun: async (value) => settlements.push(['fail', value])
    }
  })
  await runner.run({ recipeId: 'context.ingest.session', source, attemptIdentity: { runId: 'run.1', attempt: 1 } })
  assert.equal(settlements[0][0], 'complete')
  assert.deepEqual(settlements[0][1].resultSummary, { episodeCount: 1, memoryCount: 0 })

  const failed = new ContextIngestSessionRunner({
    personalContext: { ingest: async () => { throw new Error('private') } },
    storage: {
      completeFormalAgentRun: async () => {},
      failFormalAgentRun: async (value) => settlements.push(['fail', value])
    }
  })
  assert.equal(await failed.run({ recipeId: 'context.ingest.session', source, attemptIdentity: { runId: 'run.2', attempt: 1 } }), null)
  assert.deepEqual(settlements.at(-1), ['fail', {
    attemptIdentity: { runId: 'run.2', attempt: 1 }, errorCode: 'AGENT_INTERNAL_FAILURE'
  }])
})
