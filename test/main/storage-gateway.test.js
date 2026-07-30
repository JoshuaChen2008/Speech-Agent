'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageError } = require('../../src/runtime/storage-worker/protocol')
const { StorageTransportError } = require('../../src/runtime/storage-worker/worker-host')

const DATABASE_PATH = path.resolve('.artifacts', 'gateway-tests', 'speech-agent.sqlite3')

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function hostWith (overrides = {}) {
  return {
    async start () {},
    async openSession (input) { return { status: 'committed', input } },
    async appendCaption (event) { return { status: 'committed', event } },
    async closeSession (input) { return { status: 'committed', input } },
    async getSessionTranscript (sessionId) { return { sessionId } },
    async getStats () { return { sessions: 0 } },
    async shutdown () {},
    async terminateAndWait () {},
    ...overrides
  }
}

function transportFailure (message, outcome = 'unknown') {
  return new StorageTransportError('INJECTED_TRANSPORT_FAILURE', message, { outcome })
}

test('gateway keeps a cloned FIFO head until ACK and replays commit-before-ack on a fresh host', async (t) => {
  const log = []
  const durable = new Set()
  const hosts = []
  let generation = 0
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    maxRestarts: 2,
    hostFactory: ({ databasePath }) => {
      assert.equal(databasePath, DATABASE_PATH)
      const id = ++generation
      const host = hostWith({
        async start () { log.push(`start:${id}`) },
        async openSession (input) {
          log.push(`open:${id}:${input.sessionId}:${input.sourceId}`)
          if (id === 1) {
            durable.add(input.sessionId)
            throw transportFailure('worker exited after commit before ACK')
          }
          assert.equal(durable.has(input.sessionId), true)
          return { status: 'already_processed', sessionId: input.sessionId }
        },
        async appendCaption (event) {
          log.push(`append:${id}:${event.text}`)
          return { status: 'committed', eventOrder: 1 }
        },
        async terminateAndWait () { log.push(`terminated:${id}`) }
      })
      hosts.push(host)
      log.push(`created:${id}`)
      return host
    }
  })
  t.after(() => gateway.terminate())

  const open = { sessionId: 'session-1', sourceId: 'loopback', startedAt: 100 }
  const event = {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: 'frozen',
    translation: null
  }
  const openPromise = gateway.openSession(open)
  const appendPromise = gateway.appendCaption(event)
  open.sourceId = 'mic'
  event.text = 'mutated after enqueue'

  assert.equal((await openPromise).status, 'already_processed')
  assert.equal((await appendPromise).eventOrder, 1)
  await gateway.flush()

  assert.equal(hosts.length, 2)
  assert.deepEqual(log.slice(0, 8), [
    'created:1',
    'start:1',
    'open:1:session-1:loopback',
    'terminated:1',
    'created:2',
    'start:2',
    'open:2:session-1:loopback',
    'append:2:frozen'
  ])
})

test('gateway serializes commands behind an explicit in-progress host start', async (t) => {
  const ready = deferred()
  const log = []
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    hostFactory: () => hostWith({
      async start () {
        log.push('start:begin')
        await ready.promise
        log.push('start:end')
      },
      async getStats () {
        log.push('stats')
        return { sessions: 0 }
      }
    })
  })
  t.after(() => gateway.terminate())

  const started = gateway.start()
  const stats = gateway.getStats()
  await Promise.resolve()
  assert.deepEqual(log, ['start:begin'])
  ready.resolve()
  await started
  assert.deepEqual(await stats, { sessions: 0 })
  assert.deepEqual(log, ['start:begin', 'start:end', 'stats'])
})

test('gateway queue pressure retains the triggering caption in one protected overflow slot', async (t) => {
  const ready = deferred()
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    maxQueue: 1,
    hostFactory: () => hostWith({
      async start () { await ready.promise }
    })
  })
  t.after(() => gateway.terminate())

  const first = gateway.getStats()
  await Promise.resolve()
  assert.throws(
    () => gateway.appendCaption({ sessionId: 'session-1', sourceId: 'loopback', sequence: 1 }),
    (error) => error instanceof StorageError && error.code === 'STORAGE_QUEUE_FULL' &&
      error.storageRetained === true
  )
  assert.equal(gateway.faulted, true)
  assert.equal(gateway.queue.length, 2, 'the triggering write is retained beyond the soft high-water mark')
  await assert.rejects(first, (error) => error.code === 'STORAGE_QUEUE_FULL')
  ready.resolve()
})

test('gateway trips after bounded transport recovery and retry drains the retained FIFO', async (t) => {
  const log = []
  let generation = 0
  let allowSuccess = false
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    maxRestarts: 1,
    hostFactory: () => {
      const id = ++generation
      return hostWith({
        async start () { log.push(`start:${id}`) },
        async appendCaption (event) {
          log.push(`append:${id}:${event.sequence}`)
          if (!allowSuccess) throw transportFailure(`transport failure ${id}`)
          return { status: 'committed', eventOrder: event.sequence }
        },
        async getStats () {
          log.push(`stats:${id}`)
          return { sessions: 1 }
        },
        async terminateAndWait () { log.push(`terminated:${id}`) }
      })
    }
  })
  t.after(() => gateway.terminate())

  const event = {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: 'one',
    translation: null
  }
  const first = gateway.appendCaption(event)
  const queuedStats = gateway.getStats()

  await assert.rejects(gateway.flush(), /transport failure/)
  await assert.rejects(first, /transport failure/)
  await assert.rejects(queuedStats, /transport failure/)
  assert.equal(gateway.faulted, true)
  assert.equal(generation, 2, 'initial host plus one bounded restart')

  allowSuccess = true
  await gateway.retry()
  assert.deepEqual(await gateway.getStats(), { sessions: 1 })
  assert.equal(gateway.faulted, false)
  assert.match(log.join('|'), /append:3:1\|stats:3/)
})

test('gateway does not restart for acknowledged StorageError business conflicts', async (t) => {
  let hosts = 0
  let terminations = 0
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    hostFactory: () => {
      hosts += 1
      return hostWith({
        async appendCaption () { throw new StorageError('EVENT_IDENTITY_CONFLICT') },
        async terminateAndWait () { terminations += 1 }
      })
    }
  })
  t.after(() => gateway.terminate())

  await assert.rejects(
    gateway.appendCaption({ sessionId: 's', sourceId: 'mic', sequence: 1 }),
    (error) => error instanceof StorageError && error.code === 'EVENT_IDENTITY_CONFLICT'
  )
  assert.equal(hosts, 1)
  assert.equal(terminations, 0)
  assert.equal(gateway.faulted, true)
  assert.equal(gateway.queue.length, 1, 'poisoned write stays at the head so close cannot skip it')
})

test('gateway waits for old host exit before constructing its replacement', async (t) => {
  const exit = deferred()
  const log = []
  let generation = 0
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    hostFactory: () => {
      const id = ++generation
      log.push(`created:${id}`)
      return hostWith({
        async appendCaption () {
          if (id === 1) throw transportFailure('postMessage failed', 'not_sent')
          return { status: 'committed' }
        },
        async terminateAndWait () {
          log.push(`terminate-begin:${id}`)
          if (id === 1) await exit.promise
          log.push(`terminate-end:${id}`)
        }
      })
    }
  })
  t.after(() => gateway.terminate())

  const operation = gateway.appendCaption({ sessionId: 's', sourceId: 'mic', sequence: 1 })
  while (!log.includes('terminate-begin:1')) await Promise.resolve()
  assert.equal(generation, 1, 'replacement is not constructed before old exit')
  exit.resolve()
  await operation
  assert.deepEqual(log.slice(0, 4), [
    'created:1',
    'terminate-begin:1',
    'terminate-end:1',
    'created:2'
  ])
})

test('shutdown rejects while the FIFO head has no ACK and never calls host shutdown', async (t) => {
  let shutdownCalls = 0
  const gateway = new StorageGateway({
    databasePath: DATABASE_PATH,
    maxRestarts: 0,
    hostFactory: () => hostWith({
      async closeSession () { throw transportFailure('worker exited before close ACK') },
      async shutdown () { shutdownCalls += 1 }
    })
  })

  const close = gateway.closeSession({
    sessionId: 'session-1',
    sourceId: 'loopback',
    endedAt: 200,
    state: 'closed'
  })
  const shutdown = gateway.shutdown()
  await assert.rejects(shutdown, /worker exited before close ACK/)
  assert.equal(gateway.faulted, true)
  assert.equal(gateway.queue.length, 1, 'unacknowledged head is retained')
  assert.equal(shutdownCalls, 0)

  const closeRejected = assert.rejects(close, /worker exited before close ACK/)
  await gateway.terminate()
  await closeRejected
})
