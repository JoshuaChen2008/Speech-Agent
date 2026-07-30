'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  RealtimeWorkerHost,
  SERVICE_NAME: REALTIME_SERVICE_NAME
} = require('../../src/runtime/realtime-worker/worker-host')
const {
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
    if (message?.type === 'configure') setImmediate(() => child.emit('message', { type: 'configured' }))
  }
  child.kill = () => {
    child.killCount += 1
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
    start: (host) => host.start({ sessionId: 'session', sourceIds: ['mic'], recognizerProfile: 'null' })
  },
  {
    name: 'refinement',
    Host: RefineWorkerHost,
    serviceName: REFINE_SERVICE_NAME,
    start: (host) => host.start({ model: {} })
  }
]

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
    context.host.shutdown(5),
    (error) => error.code === 'UTILITY_TERMINATION_TIMEOUT'
  )
  assert.equal(context.child.killCount, 1)
  assert.strictEqual(context.host.child, context.child)
})
