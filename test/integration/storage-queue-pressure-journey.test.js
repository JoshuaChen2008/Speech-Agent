'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')

const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DATABASE_PATH = path.resolve('.artifacts', 'storage-pressure', 'speech-agent.sqlite3')

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function caption (kind, sequence, revision, sessionId = 'pressure-session') {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId: 'loopback',
    segmentId: 'pressure-segment',
    sequence,
    revision,
    kind,
    t0: 0,
    t1: 1,
    text: `durable revision ${revision}`,
    translation: null
  }
}

async function waitForPhase (coordinator, phase) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (coordinator.getSnapshot().phase === phase) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(coordinator.getSnapshot().phase, phase)
}

test('CI journey: queue pressure retains every displayed final/refined before capture resumes', async (t) => {
  const firstAppendEntered = deferred()
  const releaseFirstAppend = deferred()
  const durableSequences = []
  let appendCalls = 0
  const host = {
    async start () {},
    async openSession () { return { status: 'committed' } },
    async appendCaption (event) {
      appendCalls += 1
      if (appendCalls === 1) {
        firstAppendEntered.resolve()
        await releaseFirstAppend.promise
      }
      durableSequences.push(event.sequence)
      return { status: 'committed', eventOrder: durableSequences.length }
    },
    async closeSession () { return { status: 'committed' } },
    async getSessionTranscript () { return { session: null, segments: [] } },
    async getStats () { return { sessions: 1 } },
    async shutdown () {},
    async terminateAndWait () {}
  }
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    maxQueue: 1,
    hostFactory: () => host
  })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000300000 })
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true
    },
    idFactory: () => 'pressure-session',
    persistenceSink: recorder
  })
  t.after(async () => {
    await coordinator.dispose()
    await gateway.terminate()
  })

  const visibleSequences = []
  coordinator.onCaption((event) => visibleSequences.push(event.sequence))

  assert.equal((await coordinator.command('start')).ok, true)
  adapter.emitCaption(caption('final', 1, 1))
  await firstAppendEntered.promise

  /* The second write crosses the high-water mark. It must still enter the
     protected slot before the storage fault becomes visible to the UI. */
  adapter.emitCaption(caption('refined', 2, 2))
  assert.deepEqual(visibleSequences, [1, 2])
  assert.equal(gateway.faulted, true)
  assert.deepEqual(gateway.queue.map((item) => item.payload.sequence), [1, 2])
  assert.equal(coordinator.acceptCaption(caption('refined', 3, 3)), true)
  assert.deepEqual(visibleSequences, [1, 2], 'captions arriving during the stop boundary remain buffered')

  releaseFirstAppend.resolve()
  await waitForPhase(coordinator, 'error')
  assert.deepEqual(durableSequences, [1])
  assert.equal(adapter.context, null, 'capture remains stopped while the retained write has no ACK')

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.deepEqual(durableSequences, [1, 2, 3])
  assert.deepEqual(visibleSequences, [1, 2, 3], 'retry must not duplicate and must flush the stopped-boundary revision')
  assert.equal(gateway.queue.length, 0)

  assert.equal((await coordinator.command('stop')).ok, true)
  await gateway.shutdown()
})

test('CI journey: stop during queue pressure reaches idle only after terminal close ACK', async (t) => {
  const firstAppendEntered = deferred()
  const releaseFirstAppend = deferred()
  const thirdAppendEntered = deferred()
  const releaseThirdAppend = deferred()
  const durableSequences = []
  const closes = []
  const commitOrder = []
  let appendCalls = 0
  const host = {
    async start () {},
    async openSession () { return { status: 'committed' } },
    async appendCaption (event) {
      appendCalls += 1
      if (appendCalls === 1) {
        firstAppendEntered.resolve()
        await releaseFirstAppend.promise
      }
      if (event.sequence === 3) {
        thirdAppendEntered.resolve()
        await releaseThirdAppend.promise
      }
      durableSequences.push(event.sequence)
      commitOrder.push(`caption:${event.sequence}`)
      return { status: 'committed', eventOrder: durableSequences.length }
    },
    async closeSession (payload) {
      closes.push(structuredClone(payload))
      commitOrder.push('close')
      return { status: 'committed' }
    },
    async getSessionTranscript () { return { session: null, segments: [] } },
    async getStats () { return { sessions: 1 } },
    async shutdown () {},
    async terminateAndWait () {}
  }
  const gateway = new StorageGateway({
    databasePath: path.resolve('.artifacts', 'storage-pressure', 'stop.sqlite3'),
    maxQueue: 1,
    hostFactory: () => host
  })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000400000 })
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true
    },
    idFactory: () => 'pressure-stop-session',
    persistenceSink: recorder
  })
  t.after(async () => {
    await coordinator.dispose()
    await gateway.terminate()
  })

  assert.equal((await coordinator.command('start')).ok, true)
  adapter.emitCaption(caption('final', 1, 1, 'pressure-stop-session'))
  await firstAppendEntered.promise
  adapter.emitCaption(caption('refined', 2, 2, 'pressure-stop-session'))
  assert.equal(
    coordinator.acceptCaption(caption('refined', 3, 3, 'pressure-stop-session')),
    true,
    'a final stopped-boundary revision remains buffered while storage is faulted'
  )
  await waitForPhase(coordinator, 'error')
  assert.equal(gateway.queue.length, 2, 'caption overflow slot remains occupied before the first ACK')

  const stop = await coordinator.command('stop')
  assert.equal(stop.code, 'STORAGE_CLOSE_FAILED')
  assert.equal(coordinator.getSnapshot().phase, 'error')
  assert.equal(gateway.queue.length, 2, 'terminal close is deferred until the buffered caption is durable')
  assert.equal(closes.length, 0)

  releaseFirstAppend.resolve()
  const retry = coordinator.command('retry')
  await thirdAppendEntered.promise
  assert.equal(
    coordinator.acceptCaption(caption('refined', 4, 4, 'pressure-stop-session')),
    false,
    'after adapter.stop resolves, terminal recovery rejects late retired-generation captions'
  )
  releaseThirdAppend.resolve()
  assert.equal((await retry).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'idle')
  assert.deepEqual(durableSequences, [1, 2, 3])
  assert.deepEqual(commitOrder, ['caption:1', 'caption:2', 'caption:3', 'close'])
  assert.deepEqual(closes, [{
    sessionId: 'pressure-stop-session',
    sourceId: 'loopback',
    endedAt: 1770000400000,
    state: 'interrupted'
  }])
  assert.equal(gateway.queue.length, 0)

  await gateway.shutdown()
})
