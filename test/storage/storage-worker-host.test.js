'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  OPERATIONS,
  PROTOCOL_VERSION,
  SAFE_ERROR_MESSAGES,
  StorageError,
  makeLegacyImportKey
} = require('../../src/runtime/storage-worker/protocol')
const {
  StorageTransportError,
  StorageWorkerHost,
  isStorageTransportError
} = require('../../src/runtime/storage-worker/worker-host')

function fakeChild (options = {}) {
  const child = new EventEmitter()
  child.messages = []
  child.killCount = 0
  child.throwOnOperation = null
  child.postMessage = (message) => {
    child.messages.push(message)
    if (child.throwOnOperation === message.operation) throw new Error('injected post failure')
  }
  child.kill = () => {
    child.killCount += 1
    if (options.throwOnFirstKill === true && child.killCount === 1) throw new Error('kill was not issued')
    if (options.exitOnKill !== false) setImmediate(() => child.emit('exit', options.killExitCode || 0))
  }
  return child
}

function harness (options = {}) {
  const children = []
  const electron = {
    utilityProcess: {
      fork () {
        const child = options.childFactory ? options.childFactory(children.length) : fakeChild()
        children.push(child)
        return child
      }
    }
  }
  const host = new StorageWorkerHost({
    databasePath: path.join(os.tmpdir(), `storage-host-${Math.random()}.sqlite3`),
    requestTimeoutMs: options.requestTimeoutMs || 100,
    electron,
    onFatalError: options.onFatalError
  })
  return { children, host }
}

function requestFor (child, operation) {
  return child.messages.findLast((message) => message.operation === operation)
}

function successResponse (request, result = {}) {
  return {
    version: PROTOCOL_VERSION,
    type: 'storage:response',
    requestId: request.requestId,
    ok: true,
    result
  }
}

function errorResponse (request, code) {
  return {
    version: PROTOCOL_VERSION,
    type: 'storage:response',
    requestId: request.requestId,
    ok: false,
    error: { code, message: SAFE_ERROR_MESSAGES[code] }
  }
}

async function startReady (options = {}) {
  const context = harness(options)
  const started = context.host.start()
  const child = context.children[0]
  const initialize = requestFor(child, OPERATIONS.INITIALIZE)
  child.emit('message', successResponse(initialize, { initialized: true }))
  await started
  return { ...context, child }
}

async function terminateQuietly (host) {
  try { await host.terminateAndWait(100) } catch { /* fake cleanup is best effort */ }
}

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

test('concurrent start calls share one initialize promise and one child', async () => {
  const { children, host } = harness()
  const first = host.start()
  const second = host.start()

  assert.strictEqual(second, first)
  assert.equal(children.length, 1)
  assert.equal(children[0].messages.length, 1)
  assert.equal(children[0].messages[0].operation, OPERATIONS.INITIALIZE)

  children[0].emit('message', successResponse(children[0].messages[0], { initialized: true }))
  await first
  assert.equal(host.state, 'ready')
  assert.strictEqual(host.start(), first, 'ready generation keeps the same initialization promise')
  await terminateQuietly(host)
})

test('startup and concurrent application termination share one exact-child kill', async () => {
  const child = fakeChild({ exitOnKill: false })
  const { host } = harness({ childFactory: () => child, requestTimeoutMs: 20 })
  const starting = host.start()
  const terminating = host.terminateAndWait(100)

  await nextTurn()
  assert.equal(child.killCount, 1)
  child.emit('exit', 0)

  assert.equal(await terminating, 0)
  await assert.rejects(starting, (error) => {
    assert.equal(isStorageTransportError(error), true)
    assert.equal(error.code, 'WORKER_EXITED')
    return true
  })
  assert.equal(child.killCount, 1)
  assert.equal(host.state, 'stopped')
})

test('storage utility fatal error is consumed without retaining the V8 report', async () => {
  const diagnostics = []
  const { child, host } = await startReady({ onFatalError: (value) => diagnostics.push(value) })
  assert.doesNotThrow(() => child.emit('error', 'FatalError', 'private-location', 'sensitive report'))
  assert.deepEqual(diagnostics, [{ role: 'subtitle-storage', type: 'FatalError' }])
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|sensitive|report|location/i)
  await terminateQuietly(host)
})

test('start failure kills the exact child and waits for its exit before rejecting', async () => {
  const child = fakeChild({ exitOnKill: false })
  const { host } = harness({ childFactory: () => child, requestTimeoutMs: 100 })
  const started = host.start()
  let settled = false
  started.then(() => { settled = true }, () => { settled = true })

  child.emit('message', errorResponse(child.messages[0], 'STORAGE_COMMAND_FAILED'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(child.killCount, 1)
  assert.equal(settled, false, 'initialize failure must await the child exit')

  child.emit('exit', 0)
  await assert.rejects(started, (error) => error instanceof StorageError && error.code === 'STORAGE_COMMAND_FAILED')
  assert.equal(host.child, null)
})

test('responses are strict about version, type, requestId, ok and error shape', async (t) => {
  const invalidMutations = [
    ['wrong version', (response) => { response.version += 1 }],
    ['wrong type', (response) => { response.type = 'other:response' }],
    ['wrong requestId', (response) => { response.requestId = 'wrong-request' }],
    ['non-boolean ok', (response) => { response.ok = 'yes' }],
    ['unknown response field', (response) => { response.extra = true }]
  ]

  for (const [name, mutate] of invalidMutations) {
    await t.test(name, async () => {
      const { child, host } = await startReady()
      const pending = host.getStats()
      await nextTurn()
      const response = successResponse(requestFor(child, OPERATIONS.GET_STATS), { sessions: 0 })
      mutate(response)
      child.emit('message', response)
      await assert.rejects(pending, (error) => {
        assert.equal(isStorageTransportError(error), true)
        assert.equal(error.code, 'INVALID_RESPONSE')
        assert.equal(error.outcome, 'unknown')
        return true
      })
      await terminateQuietly(host)
    })
  }

  await t.test('invalid public error is a transport failure', async () => {
    const { child, host } = await startReady()
    const pending = host.getStats()
    await nextTurn()
    const response = errorResponse(requestFor(child, OPERATIONS.GET_STATS), 'SESSION_NOT_FOUND')
    response.error.message = 'unsafe or divergent message'
    child.emit('message', response)
    await assert.rejects(pending, (error) => error instanceof StorageTransportError && error.code === 'INVALID_RESPONSE')
    await terminateQuietly(host)
  })

  await t.test('valid public error stays a business StorageError', async () => {
    const { child, host } = await startReady()
    const pending = host.getStats()
    await nextTurn()
    child.emit('message', errorResponse(requestFor(child, OPERATIONS.GET_STATS), 'SESSION_NOT_FOUND'))
    await assert.rejects(pending, (error) => {
      assert.equal(error instanceof StorageError, true)
      assert.equal(isStorageTransportError(error), false)
      assert.equal(error.code, 'SESSION_NOT_FOUND')
      return true
    })
    await terminateQuietly(host)
  })
})

test('synchronous postMessage failure cleans request listeners and invalidates the generation', async () => {
  const { child, host } = await startReady({ requestTimeoutMs: 25 })
  const baselineExitListeners = child.listenerCount('exit')
  child.throwOnOperation = OPERATIONS.GET_STATS

  await assert.rejects(host.getStats(), (error) => {
    assert.equal(error instanceof StorageTransportError, true)
    assert.equal(error.code, 'POST_MESSAGE_FAILED')
    assert.equal(error.outcome, 'not_sent')
    return true
  })
  assert.equal(child.listenerCount('message'), 0)
  assert.equal(child.listenerCount('exit'), baselineExitListeners)
  assert.equal(host.state, 'failed')
  await terminateQuietly(host)
})

test('request timeout is an unknown transport outcome and blocks later commands on that generation', async () => {
  const { child, host } = await startReady({ requestTimeoutMs: 15 })
  const before = child.messages.length

  await assert.rejects(host.getStats(), (error) => {
    assert.equal(isStorageTransportError(error), true)
    assert.equal(error.code, 'REQUEST_TIMEOUT')
    assert.equal(error.outcome, 'unknown')
    return true
  })
  await assert.rejects(host.getStats(), (error) => {
    assert.equal(isStorageTransportError(error), true)
    assert.equal(error.code, 'HOST_NOT_READY')
    assert.equal(error.outcome, 'not_sent')
    return true
  })
  assert.equal(child.messages.length, before + 1, 'no command may pass the timed-out generation')
  await terminateQuietly(host)
})

test('terminateAndWait is shared, awaits exit and only kills the captured child', async () => {
  const unrelated = fakeChild()
  const { child, host } = await startReady()
  const first = host.terminateAndWait(100)
  const second = host.terminateAndWait(100)

  assert.strictEqual(second, first)
  assert.equal(child.killCount, 1)
  assert.equal(unrelated.killCount, 0)
  assert.equal(await first, 0)
  assert.equal(host.child, null)
  assert.equal(host.state, 'stopped')
})

test('terminateAndWait reports a distinguishable timeout when the exact child stays alive', async () => {
  const child = fakeChild({ exitOnKill: false })
  const { host } = await startReady({ childFactory: () => child, requestTimeoutMs: 20 })

  await assert.rejects(host.terminateAndWait(10), (error) => {
    assert.equal(isStorageTransportError(error), true)
    assert.equal(error.code, 'TERMINATION_TIMEOUT')
    assert.equal(error.outcome, 'unknown')
    return true
  })
  assert.equal(child.killCount, 1)

  let settled = false
  const joined = host.terminateAndWait(100)
  joined.then(() => { settled = true }, () => { settled = true })
  await nextTurn()
  assert.equal(child.killCount, 1, 'late reap retry must not kill the exact child twice')
  assert.equal(settled, false)

  child.emit('exit', 0)
  assert.equal(await joined, 0)
  assert.equal(await host.waitForExactExit(), 0)
  assert.equal(host.state, 'stopped')
})

test('termination can retry when the first child kill threw before being issued', async () => {
  const child = fakeChild({ throwOnFirstKill: true })
  const { host } = await startReady({ childFactory: () => child, requestTimeoutMs: 20 })

  await assert.rejects(host.terminateAndWait(10), (error) => {
    assert.equal(error.code, 'TERMINATION_TIMEOUT')
    return true
  })
  assert.equal(child.killCount, 1)
  assert.equal(await host.terminateAndWait(100), 0)
  assert.equal(child.killCount, 2)
})

test('concurrent shutdown calls share one drain and one shutdown request', async () => {
  const { child, host } = await startReady()
  const first = host.shutdown()
  const second = host.shutdown()
  assert.strictEqual(second, first)

  await new Promise((resolve) => setImmediate(resolve))
  const request = requestFor(child, OPERATIONS.SHUTDOWN)
  assert.ok(request)
  assert.equal(child.messages.filter((message) => message.operation === OPERATIONS.SHUTDOWN).length, 1)
  child.emit('message', successResponse(request, { stopped: true }))
  child.emit('exit', 0)

  await first
  assert.equal(host.state, 'closed')
  assert.equal(host.child, null)
  assert.strictEqual(host.shutdown(), first)
})

test('legacy JSONL import is forwarded with a source-SHA idempotency key', async () => {
  const { child, host } = await startReady()
  const sourceSha256 = 'b'.repeat(64)
  const payload = {
    sourceSha256,
    sourceName: 'legacy.jsonl',
    importedAt: 1000,
    sourceRecordCount: 3,
    captionEventCount: 1,
    translatedEventCount: 0,
    corruptLineCount: 0,
    truncatedTail: false,
    session: null,
    captions: []
  }
  const pending = host.importLegacyJsonl(payload)
  await nextTurn()
  const request = requestFor(child, OPERATIONS.IMPORT_LEGACY_JSONL)
  assert.deepEqual(request.payload, payload)
  assert.equal(request.idempotencyKey, makeLegacyImportKey(sourceSha256))
  child.emit('message', successResponse(request, { status: 'skipped' }))
  assert.deepEqual(await pending, { status: 'skipped' })
  await terminateQuietly(host)
})

test('stale-session recovery forwards only the startup timestamp', async () => {
  const { child, host } = await startReady()
  const payload = { recoveredAt: 1775000000000 }
  const pending = host.recoverStaleSessions(payload)
  await nextTurn()
  const request = requestFor(child, OPERATIONS.RECOVER_STALE_SESSIONS)
  assert.deepEqual(request.payload, { recoveredAt: 1775000000000 })
  assert.equal(Object.hasOwn(request, 'idempotencyKey'), false)
  child.emit('message', successResponse(request, {
    status: 'committed', recoveredSessionCount: 1
  }))
  assert.deepEqual(await pending, { status: 'committed', recoveredSessionCount: 1 })
  await terminateQuietly(host)
})

test('history listing forwards the exact keyset payload without an idempotency key', async () => {
  const { child, host } = await startReady()
  const payload = { limit: 25, cursor: { startedAt: 1775000000000, sessionId: 'session-9' } }
  const pending = host.listSessions(payload)
  await nextTurn()
  const request = requestFor(child, OPERATIONS.LIST_SESSIONS)
  assert.deepEqual(request.payload, payload)
  assert.equal(Object.hasOwn(request, 'idempotencyKey'), false)
  child.emit('message', successResponse(request, { items: [], nextCursor: null }))
  assert.deepEqual(await pending, { items: [], nextCursor: null })
  await terminateQuietly(host)
})

test('history detail forwards the exact segment keyset payload without an idempotency key', async () => {
  const { child, host } = await startReady()
  const payload = {
    sessionId: 'session-9',
    limit: 50,
    cursor: { t0Ms: 1775, firstEventOrder: 80 }
  }
  const pending = host.getSessionPage(payload)
  await nextTurn()
  const request = requestFor(child, OPERATIONS.GET_SESSION_PAGE)
  assert.deepEqual(request.payload, payload)
  assert.equal(Object.hasOwn(request, 'idempotencyKey'), false)
  const result = {
    session: {
      sessionId: 'session-9', mode: 'meeting', sourceId: 'loopback',
      startedAt: 1000, endedAt: 5000, state: 'closed'
    },
    totalCount: 0,
    items: [],
    nextCursor: null
  }
  child.emit('message', successResponse(request, result))
  assert.deepEqual(await pending, result)
  await terminateQuietly(host)
})
