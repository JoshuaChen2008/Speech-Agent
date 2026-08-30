'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')

function caption (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '定稿。',
    translation: null,
    ...overrides
  }
}

function gatewayFixture (overrides = {}) {
  const calls = []
  const gateway = {
    openSession: async (payload) => { calls.push(['open', structuredClone(payload)]); return { status: 'committed' } },
    recordRefinementFault: async (payload) => { calls.push(['refinementFault', structuredClone(payload)]); return { status: 'committed' } },
    appendCaption: async (event) => { calls.push(['append', structuredClone(event)]); return { status: 'committed' } },
    closeSession: async (payload) => { calls.push(['close', structuredClone(payload)]); return { status: 'committed' } },
    flush: async () => { calls.push(['flush']); return { flushed: true } },
    retry: async () => { calls.push(['retry']); return { recovered: true } },
    ...overrides
  }
  return { calls, gateway }
}

test('SQLite recorder freezes one XOR session and persists only final/refined', async () => {
  const { calls, gateway } = gatewayFixture()
  const clock = [1000, 9000]
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock.shift() })

  await recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback' })
  await recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback' })
  assert.equal(recorder.acceptCaption(caption({ kind: 'partial', text: '临时' })), false)
  assert.equal(recorder.acceptCaption(caption({
    kind: 'translated',
    revision: 2,
    sequence: 2,
    translation: { language: 'en', text: 'legacy', basedOnRevision: 1 }
  })), false)
  await recorder.acceptCaption(caption())
  await recorder.acceptCaption(caption({ sequence: 2, revision: 2, kind: 'refined', text: '精修。' }))
  await recorder.closeSession({ sessionId: 'session-1', sourceId: 'loopback', state: 'closed' })

  assert.deepEqual(calls.map(([operation]) => operation), ['open', 'append', 'append', 'close'])
  assert.deepEqual(calls[0][1], {
    sessionId: 'session-1', sourceId: 'loopback', startedAt: 1000, refinementEnabled: false
  })
  assert.deepEqual(calls[3][1], {
    sessionId: 'session-1', sourceId: 'loopback', endedAt: 9000, state: 'closed'
  })
  assert.equal(recorder.getActiveSession(), null)
})

test('SQLite recorder resubmits the same frozen open when capacity rejected it before enqueue', async () => {
  const injected = new Error('queue rejected open')
  injected.storageRetained = false
  let openAttempts = 0
  const { calls, gateway } = gatewayFixture({
    openSession: async (payload) => {
      calls.push(['open', structuredClone(payload)])
      openAttempts += 1
      if (openAttempts === 1) throw injected
      return { status: 'committed' }
    }
  })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 3000 })
  await assert.rejects(
    recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback' }),
    /rejected open/
  )

  await recorder.retry()
  assert.equal(openAttempts, 2)
  assert.deepEqual(calls.filter(([operation]) => operation === 'open').map(([, payload]) => payload), [
    { sessionId: 'session-1', sourceId: 'loopback', startedAt: 3000, refinementEnabled: false },
    { sessionId: 'session-1', sourceId: 'loopback', startedAt: 3000, refinementEnabled: false }
  ])
  assert.deepEqual(recorder.getActiveSession(), {
    sessionId: 'session-1', sourceId: 'loopback', startedAt: 3000,
    refinementEnabled: false, closePayload: null
  })
})

test('SQLite recorder keeps the frozen close payload until Gateway retry drains it', async () => {
  const injected = new Error('transport exhausted')
  injected.storageRetained = true
  let closeAttempts = 0
  const { calls, gateway } = gatewayFixture({
    closeSession: async (payload) => {
      calls.push(['close', structuredClone(payload)])
      closeAttempts += 1
      throw injected
    }
  })
  const errors = []
  const clock = [1000, 5000]
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock.shift(), onError: (error) => errors.push(error) })
  await recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback' })
  await assert.rejects(
    recorder.closeSession({ sessionId: 'session-1', sourceId: 'loopback', state: 'interrupted' }),
    /transport exhausted/
  )
  assert.deepEqual(recorder.getActiveSession().closePayload, {
    sessionId: 'session-1', sourceId: 'loopback', endedAt: 5000, state: 'interrupted'
  })
  await recorder.retry()
  assert.equal(closeAttempts, 1, 'Gateway owns replay; Recorder must not create a second close payload')
  assert.equal(recorder.getActiveSession(), null)
  assert.equal(errors.length, 1)
})

test('SQLite recorder resubmits the same frozen close when capacity rejected it before enqueue', async () => {
  const injected = new Error('queue has no terminal slot')
  injected.storageRetained = false
  let closeAttempts = 0
  const { calls, gateway } = gatewayFixture({
    closeSession: async (payload) => {
      calls.push(['close', structuredClone(payload)])
      closeAttempts += 1
      if (closeAttempts === 1) throw injected
      return { status: 'committed' }
    }
  })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 7000 })
  await recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback' })
  await assert.rejects(
    recorder.closeSession({ sessionId: 'session-1', sourceId: 'loopback', state: 'closed' }),
    /no terminal slot/
  )

  await recorder.retry()
  assert.equal(closeAttempts, 2)
  assert.deepEqual(calls.filter(([operation]) => operation === 'close').map(([, payload]) => payload), [
    { sessionId: 'session-1', sourceId: 'loopback', endedAt: 7000, state: 'closed' },
    { sessionId: 'session-1', sourceId: 'loopback', endedAt: 7000, state: 'closed' }
  ])
  assert.equal(recorder.getActiveSession(), null)
})

test('SQLite recorder rejects cross-session/source close without mutating the active identity', async () => {
  const { gateway } = gatewayFixture()
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  await recorder.openSession({ sessionId: 'session-1', sourceId: 'mic' })
  assert.throws(
    () => recorder.openSession({ sessionId: 'session-2', sourceId: 'loopback' }),
    /another durable/
  )
  assert.throws(
    () => recorder.closeSession({ sessionId: 'session-1', sourceId: 'loopback', state: 'closed' }),
    /does not match/
  )
  assert.equal(recorder.getActiveSession().sourceId, 'mic')
})

test('J15c recorder freezes refinement preference and sends only a stable fault envelope', async () => {
  const { calls, gateway } = gatewayFixture()
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  await recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback', refinementEnabled: true })
  await recorder.recordRefinementFault({
    sessionId: 'session-1',
    faultCode: 'REFINE_WORKER_EXITED',
    faultAtMs: 300
  })
  assert.deepEqual(calls.slice(0, 2), [
    ['open', {
      sessionId: 'session-1', sourceId: 'loopback', startedAt: 1000, refinementEnabled: true
    }],
    ['refinementFault', {
      sessionId: 'session-1', faultCode: 'REFINE_WORKER_EXITED', faultAtMs: 300
    }]
  ])
  assert.throws(
    () => recorder.openSession({ sessionId: 'session-1', sourceId: 'loopback', refinementEnabled: false }),
    /refinement preference is already frozen/
  )
  assert.throws(
    () => recorder.recordRefinementFault({
      sessionId: 'session-1', faultCode: 'raw Error.stack', faultAtMs: 301
    }),
    /valid refinement fault/
  )
})

test('SEM-F28/SEM-F30/J21: terminal listeners run detached only after close ACK and cannot change its receipt', async () => {
  let acknowledge
  const { gateway } = gatewayFixture({
    closeSession: () => new Promise((resolve) => { acknowledge = resolve })
  })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  const notifications = []
  recorder.onTerminalCommitted((notice) => notifications.push(notice))
  recorder.onTerminalCommitted(() => { throw new Error('scheduler failure') })
  await recorder.openSession({ sessionId: 'session-terminal', sourceId: 'mic' })
  const close = recorder.closeSession({ sessionId: 'session-terminal', sourceId: 'mic', state: 'closed' })
  await Promise.resolve()
  assert.deepEqual(notifications, [])
  acknowledge({ status: 'committed' })
  assert.deepEqual(await close, { status: 'committed' })
  await Promise.resolve()
  assert.deepEqual(notifications, [{ sessionId: 'session-terminal' }])

  recorder.clearTerminalCommittedListeners()
  await recorder.openSession({ sessionId: 'session-next', sourceId: 'mic' })
  const nextClose = recorder.closeSession({ sessionId: 'session-next', sourceId: 'mic', state: 'closed' })
  acknowledge({ status: 'committed-next' })
  assert.deepEqual(await nextClose, { status: 'committed-next' })
  await Promise.resolve()
  assert.equal(notifications.length, 1)
})
