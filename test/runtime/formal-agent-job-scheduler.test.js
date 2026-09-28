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
  const jobs = [{ runId: 'run.1', attemptIdentity: { runId: 'run.1', attempt: 1, owner: 'owner.1', leaseExpiresAt: 30000 } }, null]
  const claims = []
  const runs = []
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.1',
    storage: {
      claimNextFormalAgentRun: async (identity) => { claims.push(identity); return jobs.shift() },
      renewFormalAgentRun: async ({ attemptIdentity, leaseMs }) => ({
        runId: attemptIdentity.runId,
        attemptIdentity: { ...attemptIdentity, leaseExpiresAt: attemptIdentity.leaseExpiresAt + leaseMs }
      }),
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

test('SEM-F00/SEM-F28/SEM-T04/J21: stop invalidates a hung claim without delaying subtitle shutdown', async () => {
  let releaseClaim
  const scheduler = new FormalAgentJobScheduler({
    storage: {
      claimNextFormalAgentRun: async () => new Promise((resolve) => { releaseClaim = resolve }),
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async () => {} }
  })
  scheduler.start()
  await settled()
  await Promise.race([
    scheduler.stop(),
    new Promise((_, reject) => setImmediate(() => reject(new Error('scheduler stop waited for claim'))))
  ])
  releaseClaim(null)
})

test('SEM-F28/SEM-T04/J22/J24: scheduler stop aborts an active Agent attempt without waiting for the runner', async () => {
  let resolveClaim
  let signal
  const scheduler = new FormalAgentJobScheduler({
    storage: {
      claimNextFormalAgentRun: async () => new Promise((resolve) => { resolveClaim = resolve }),
      renewFormalAgentRun: async ({ attemptIdentity, leaseMs }) => ({
        runId: attemptIdentity.runId,
        attemptIdentity: { ...attemptIdentity, leaseExpiresAt: attemptIdentity.leaseExpiresAt + leaseMs }
      }),
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async (job) => { signal = job.signal; await new Promise(() => {}) } }
  })
  scheduler.start()
  await settled()
  resolveClaim({ runId: 'run.abort', recipeId: 'context.ingest.session', source: {}, attemptIdentity: { runId: 'run.abort', attempt: 1, owner: 'owner', leaseExpiresAt: 1 } })
  await settled()
  await scheduler.stop()
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason.code, 'AGENT_SCHEDULER_STOPPED')
})

test('SEM-F28/J30-RECOVERY: user scheduler renews the active owner lease every ten seconds', async () => {
  const timers = []
  const identity = { runId: 'run.lease.renew', attempt: 1, owner: 'owner.lease', leaseExpiresAt: 30000 }
  let releaseRun
  let renewals = 0
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.lease', requestedBy: 'user', leaseMs: 30000,
    storage: {
      claimNextFormalAgentRun: async () => ({ runId: identity.runId, recipeId: 'qa.answer', attemptIdentity: identity }),
      renewFormalAgentRun: async ({ attemptIdentity: requested, leaseMs }) => {
        renewals += 1
        assert.equal(requested.leaseExpiresAt, identity.leaseExpiresAt)
        assert.equal(leaseMs, 30000)
        return { runId: identity.runId, attemptIdentity: { ...requested, leaseExpiresAt: requested.leaseExpiresAt + leaseMs } }
      },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async () => new Promise((resolve) => { releaseRun = resolve }) },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  assert.equal(timers[0].delay, 10000)
  timers[0].callback()
  await settled()
  assert.equal(renewals, 1)
  assert.equal(identity.leaseExpiresAt, 60000)
  assert.equal(timers.at(-1).delay, 10000)
  await scheduler.stop()
  releaseRun()
})

test('SEM-F38/SEM-T04/J30-RECOVERY: lease settlement deducts elapsed time and enforces the renewed deadline', async () => {
  let monotonic = 1000
  const timers = []
  let signal
  let renewal
  const identity = { runId: 'run.budget.deadline', attempt: 1, owner: 'owner.budget', leaseExpiresAt: 30000 }
  const scheduler = new FormalAgentJobScheduler({
    owner: identity.owner,
    requestedBy: 'user',
    leaseRenewEveryMs: 20,
    monotonicNow: () => monotonic,
    storage: {
      claimNextFormalAgentRun: async () => ({
        runId: identity.runId,
        recipeId: 'summary.minutes',
        attemptIdentity: identity,
        remainingWallClockMs: 900
      }),
      renewFormalAgentRun: async (request) => {
        renewal = request
        return {
          runId: identity.runId,
          attemptIdentity: { ...request.attemptIdentity, leaseExpiresAt: identity.leaseExpiresAt + request.leaseMs },
          remainingWallClockMs: 700
        }
      },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async (job) => { signal = job.signal; await new Promise(() => {}) } },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  await settled()
  assert.equal(signal.aborted, false)
  monotonic = 1200
  timers.find((timer) => timer.delay === 20).callback()
  await settled()
  assert.equal(renewal.elapsedMs, 200)
  assert.equal(timers.some((timer) => timer.delay === 700), true)
  timers.find((timer) => timer.delay === 700).callback()
  await settled()
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason.code, 'AGENT_BUDGET_EXCEEDED')
  await scheduler.stop()
})

test('SEM-F28/SEM-T04/J30-RECOVERY: failed renewal aborts the attempt and emits only a stable diagnostic', async () => {
  const timers = []
  const diagnostics = []
  let signal
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.lease.loss', requestedBy: 'user',
    storage: {
      claimNextFormalAgentRun: async () => ({
        runId: 'run.lease.loss', recipeId: 'qa.answer',
        attemptIdentity: { runId: 'run.lease.loss', attempt: 1, owner: 'owner.lease.loss', leaseExpiresAt: 30000 }
      }),
      renewFormalAgentRun: async () => { throw new Error('private database detail') },
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async (job) => { signal = job.signal; await new Promise(() => {}) } },
    onDiagnostic: (value) => diagnostics.push(value),
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimer: () => {}
  })
  scheduler.start()
  await settled()
  timers[0].callback()
  await settled()
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason.code, 'AGENT_LEASE_LOST')
  assert.deepEqual(diagnostics, [{ code: 'AGENT_SCHEDULER_FAILED' }])
  await scheduler.stop()
})

test('SEM-F28/SEM-T04/J30-RECOVERY: a claimed run without lease renewal support makes no runner call', async () => {
  const diagnostics = []
  const jobs = [
    { runId: 'run.no-renew', recipeId: 'qa.answer', attemptIdentity: { runId: 'run.no-renew', attempt: 1, owner: 'owner.no-renew', leaseExpiresAt: 30000 } },
    null
  ]
  let runCount = 0
  const scheduler = new FormalAgentJobScheduler({
    owner: 'owner.no-renew', requestedBy: 'user',
    storage: {
      claimNextFormalAgentRun: async () => jobs.shift(),
      nextFormalAgentRunAt: async () => null
    },
    runner: { run: async () => { runCount += 1 } },
    onDiagnostic: (value) => diagnostics.push(value)
  })
  scheduler.start()
  await settled()
  assert.equal(runCount, 0)
  assert.deepEqual(diagnostics, [{ code: 'AGENT_SCHEDULER_FAILED' }])
  await scheduler.stop()
})

test('SEM-F28/SEM-T04/J22/J24: a replaced scheduler generation ignores a late Agent result', async () => {
  let resolveClaim
  let releaseRun
  let runCount = 0
  let signal
  const scheduler = new FormalAgentJobScheduler({
    storage: {
      claimNextFormalAgentRun: async () => new Promise((resolve) => { resolveClaim = resolve }),
      renewFormalAgentRun: async ({ attemptIdentity, leaseMs }) => ({
        runId: attemptIdentity.runId,
        attemptIdentity: { ...attemptIdentity, leaseExpiresAt: attemptIdentity.leaseExpiresAt + leaseMs }
      }),
      nextFormalAgentRunAt: async () => null
    },
    runner: {
      run: async (job) => {
        runCount += 1
        signal = job.signal
        await new Promise((resolve) => { releaseRun = resolve })
      }
    }
  })
  scheduler.start()
  await settled()
  resolveClaim({
    runId: 'run.replaced', recipeId: 'qa.answer', requestedBy: 'user', source: {},
    attemptIdentity: { runId: 'run.replaced', attempt: 1, owner: 'owner', leaseExpiresAt: 1 },
    interactionId: 'interaction.replaced'
  })
  await settled()
  await scheduler.stop()
  assert.equal(signal.aborted, true)
  releaseRun()
  await settled()
  assert.equal(runCount, 1)
  assert.equal(scheduler.generation > 1, true)
})

test('SEM-F28/J22/J24: user scheduler scopes claims and wakeups to user recipes', async () => {
  const claims = []
  const nextRequests = []
  const scheduler = new FormalAgentJobScheduler({
    storage: {
      claimNextFormalAgentRun: async (request) => { claims.push(request); return null },
      nextFormalAgentRunAt: async (request) => { nextRequests.push(request); return null }
    },
    runner: { run: async () => null },
    owner: 'scheduler.user', requestedBy: 'user', queueMicrotask: (callback) => callback()
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  await scheduler.stop()
  assert.deepEqual(claims[0], {
    claimIdempotencyKey: 'scheduler.user.1', owner: 'scheduler.user', leaseMs: 30000, requestedBy: 'user'
  })
  assert.deepEqual(nextRequests, [{ requestedBy: 'user' }])
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
