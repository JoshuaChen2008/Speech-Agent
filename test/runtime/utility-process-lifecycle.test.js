'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  DEFAULT_FORCE_KILL_TIMEOUT_MS: REALTIME_FORCE_KILL_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS: REALTIME_SHUTDOWN_TIMEOUT_MS,
  RealtimeWorkerHost,
  SERVICE_NAME: REALTIME_SERVICE_NAME
} = require('../../src/runtime/realtime-worker/worker-host')
const {
  DEFAULT_FORCE_KILL_TIMEOUT_MS: REFINE_FORCE_KILL_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS: REFINE_SHUTDOWN_TIMEOUT_MS,
  RefineWorkerHost,
  SERVICE_NAME: REFINE_SERVICE_NAME
} = require('../../src/runtime/refine-worker/worker-host')

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

function controlledChild (options = {}) {
  const child = new EventEmitter()
  child.messages = []
  child.killCount = 0
  child.postMessage = (message) => {
    child.messages.push(message)
    if (message?.type === 'configure' && options.configureResponse !== false) {
      setImmediate(() => child.emit('message', { type: 'configured' }))
    }
    if (message?.type === 'shutdown' && options.exitOnShutdown === true) {
      setImmediate(() => child.emit('exit', options.shutdownExitCode ?? 0))
    }
  }
  child.kill = () => {
    child.killCount += 1
    if (options.throwOnFirstKill === true && child.killCount === 1) throw new Error('kill was not issued')
    if (options.exitOnKill !== false) setImmediate(() => child.emit('exit', options.killExitCode ?? 0))
    return true
  }
  return child
}

function harness (Host, options = {}) {
  const child = controlledChild(options.childOptions)
  let forkArguments = null
  const fatal = []
  const host = new Host({
    electron: {
      utilityProcess: {
        fork (...args) {
          forkArguments = args
          return child
        }
      }
    },
    onFatalError: (diagnostic) => fatal.push(diagnostic)
  })
  return { child, fatal, forkArguments: () => forkArguments, host }
}

const CASES = [
  {
    name: 'realtime',
    Host: RealtimeWorkerHost,
    serviceName: REALTIME_SERVICE_NAME,
    start: (host) => host.start({ sessionId: 'session', sourceIds: ['mic'], recognizerProfile: 'null' }),
    startWithTimeout: (host, configureTimeoutMs) => host.start({
      sessionId: 'session',
      sourceIds: ['mic'],
      recognizerProfile: 'null',
      configureTimeoutMs
    })
  },
  {
    name: 'refinement',
    Host: RefineWorkerHost,
    serviceName: REFINE_SERVICE_NAME,
    start: (host) => host.start({ model: {} }),
    startWithTimeout: (host, configureTimeoutMs) => host.start({ model: {}, configureTimeoutMs })
  }
]

test('native utility defaults reserve model/decode grace before exact-child kill', () => {
  assert.equal(REALTIME_SHUTDOWN_TIMEOUT_MS, 30000)
  assert.equal(REFINE_SHUTDOWN_TIMEOUT_MS, 30000)
  assert.equal(REALTIME_FORCE_KILL_TIMEOUT_MS, 5000)
  assert.equal(REFINE_FORCE_KILL_TIMEOUT_MS, 5000)
})

for (const entry of CASES) {
  test(`${entry.name} utility process has a role and graceful shutdown waits for exact exit`, async () => {
    const context = harness(entry.Host)
    await entry.start(context.host)
    assert.equal(context.forkArguments()[2].serviceName, entry.serviceName)

    let settled = false
    const shutdown = context.host.shutdown(100)
    shutdown.then(() => { settled = true }, () => { settled = true })
    await nextTurn()
    assert.deepEqual(context.child.messages.at(-1), { type: 'shutdown' })
    assert.equal(settled, false)
    assert.strictEqual(context.host.child, context.child, 'kill/request must not clear the child before exit')

    context.child.emit('exit', 0)
    assert.deepEqual(await shutdown, { graceful: true, reason: null, exitCode: 0 })
    assert.equal(context.host.child, null)
  })

  test(`${entry.name} utility fatal error is consumed and exposes no report or location`, async () => {
    const context = harness(entry.Host)
    const exits = []
    context.host.onExit((value) => exits.push(value))
    await entry.start(context.host)

    assert.doesNotThrow(() => {
      context.child.emit('error', 'FatalError', 'private-location', 'sensitive diagnostic report')
    })
    assert.deepEqual(context.fatal, [{
      role: entry.name === 'realtime' ? 'realtime-asr' : 'offline-refinement',
      type: 'FatalError'
    }])
    assert.doesNotMatch(JSON.stringify(context.fatal), /private|sensitive|report|location/i)
    context.child.emit('exit', 13)
    assert.deepEqual(exits, [{ code: 13 }])
  })

  test(`${entry.name} dispose is graceful-first and waits for the exact child exit`, async () => {
    const context = harness(entry.Host)
    await entry.start(context.host)

    let settled = false
    const disposal = context.host.dispose()
    disposal.then(() => { settled = true }, () => { settled = true })
    await nextTurn()

    assert.deepEqual(context.child.messages.at(-1), { type: 'shutdown' })
    assert.equal(context.child.killCount, 0)
    assert.equal(settled, false)
    context.child.emit('exit', 0)
    assert.deepEqual(await disposal, { graceful: true, reason: null, exitCode: 0 })
  })

  test(`${entry.name} configure failure requests graceful shutdown before any kill`, async () => {
    const context = harness(entry.Host, {
      childOptions: { configureResponse: false, exitOnShutdown: true }
    })

    await assert.rejects(entry.startWithTimeout(context.host, 5), /configure timed out/)
    assert.deepEqual(context.child.messages.map((message) => message.type), ['configure', 'shutdown'])
    assert.equal(context.child.killCount, 0)
    assert.equal(context.host.child, null)
  })

  test(`${entry.name} late exact exit can be joined after the bounded termination deadline without a second kill`, async () => {
    const context = harness(entry.Host, { childOptions: { exitOnKill: false } })
    await entry.start(context.host)

    await assert.rejects(context.host.terminateAndWait(5), /timed out/i)
    assert.equal(context.child.killCount, 1)
    assert.strictEqual(context.host.child, context.child)

    let settled = false
    const joined = context.host.terminateAndWait(100)
    joined.then(() => { settled = true }, () => { settled = true })
    await nextTurn()
    assert.equal(context.child.killCount, 1, 'the exact child is never killed twice')
    assert.equal(settled, false)

    context.child.emit('exit', 0)
    assert.equal(await joined, 0)
    assert.equal(await context.host.waitForExactExit(), 0)
    assert.equal(context.host.child, null)
  })

  test(`${entry.name} can retry a termination call that threw before it was issued`, async () => {
    const context = harness(entry.Host, { childOptions: { throwOnFirstKill: true } })
    await entry.start(context.host)

    await assert.rejects(context.host.terminateAndWait(5), /timed out/i)
    assert.equal(context.child.killCount, 1)
    assert.equal(await context.host.terminateAndWait(100), 0)
    assert.equal(context.child.killCount, 2, 'only the unissued kill call is retried')
  })
}

test('graceful timeout kills realtime worker and still waits for exit', async () => {
  const context = harness(RealtimeWorkerHost)
  await context.host.start({ sessionId: 'session', sourceIds: ['mic'], recognizerProfile: 'null' })
  const outcome = await context.host.shutdown(5)
  assert.deepEqual(outcome, { graceful: false, reason: 'SHUTDOWN_TIMEOUT', exitCode: 0 })
  assert.equal(context.child.killCount, 1)
  assert.equal(context.host.child, null)
})

test('unreaped refinement worker fails closed after graceful and forced deadlines', async () => {
  const context = harness(RefineWorkerHost, { childOptions: { exitOnKill: false } })
  await context.host.start({ model: {} })
  await assert.rejects(
    context.host.shutdown(5, 5),
    (error) => error.code === 'UTILITY_TERMINATION_TIMEOUT'
  )
  assert.equal(context.child.killCount, 1)
  assert.strictEqual(context.host.child, context.child)
})
