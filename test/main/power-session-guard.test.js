'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const { PowerSessionGuard, SYSTEM_SUSPEND_FAULT } = require('../../src/main/services/power-session-guard')

const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DICTATION = Object.freeze({
  onboardingCompleted: true,
  onboardingPreset: 'dictation',
  mic: true,
  loopback: false
})

function createFaultingAdapter () {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  let errorHandler = null
  const originalStart = adapter.start.bind(adapter)
  adapter.startCalls = 0
  adapter.start = async (context) => {
    adapter.startCalls += 1
    return originalStart(context)
  }
  adapter.onError = (handler) => {
    errorHandler = handler
    return () => { if (errorHandler === handler) errorHandler = null }
  }
  adapter.interruptForSystemSuspend = () => {
    if (!adapter.context) return false
    if (errorHandler) errorHandler(structuredClone(SYSTEM_SUSPEND_FAULT))
    return true
  }
  return adapter
}

test('power guard reports one recoverable sleep fault and never auto-restarts after resume', async (t) => {
  const powerMonitor = new EventEmitter()
  const adapter = createFaultingAdapter()
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'sleep-session'
  })
  const guard = new PowerSessionGuard({ powerMonitor, getCoordinator: () => coordinator })
  t.after(async () => {
    guard.stop()
    await coordinator.dispose()
  })

  assert.equal(guard.start(), true)
  assert.equal(guard.start(), false, 'subscribing twice would duplicate system faults')
  assert.equal((await coordinator.command('start')).ok, true)
  assert.equal(adapter.startCalls, 1)
  const sessionId = coordinator.getSnapshot().sessionId

  powerMonitor.emit('suspend')
  assert.equal(coordinator.getSnapshot().phase, 'error')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId)
  assert.deepEqual(coordinator.getSnapshot().lastError, {
    ...SYSTEM_SUSPEND_FAULT,
    nextAction: 'retry'
  })
  const revisionAfterFirstSuspend = coordinator.getSnapshot().revision
  powerMonitor.emit('suspend')
  assert.equal(coordinator.getSnapshot().revision, revisionAfterFirstSuspend,
    'repeated suspend within one sleep cycle must not replace the recoverable error')

  powerMonitor.emit('resume')
  assert.equal(adapter.startCalls, 1, 'resume must not silently reacquire microphone/loopback')
  assert.equal(coordinator.getSnapshot().phase, 'error')

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId)
  assert.equal(adapter.startCalls, 2, 'only the explicit Retry may reacquire the source')
})

test('power guard isolates observer errors and unregisters cleanly', async () => {
  const powerMonitor = new EventEmitter()
  const errors = []
  let calls = 0
  const guard = new PowerSessionGuard({
    powerMonitor,
    getCoordinator: () => ({
      reportSystemSuspend () {
        calls += 1
        throw new Error('test observer error')
      }
    }),
    onError: (error) => errors.push(error.message)
  })

  assert.equal(guard.handleSuspend(), false)
  assert.deepEqual(errors, ['test observer error'])
  assert.equal(calls, 1)
  assert.equal(guard.handleResume(), true)

  assert.equal(guard.start(), true)
  assert.equal(guard.stop(), true)
  powerMonitor.emit('suspend')
  assert.equal(calls, 1, 'stopped guard must remove power-monitor listeners')
  assert.throws(
    () => new PowerSessionGuard({ powerMonitor: {}, getCoordinator: () => null }),
    /powerMonitor/
  )
})
