'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  OVERLAY_STARTUP_TIMEOUT_MS,
  OverlayStartupController
} = require('../../src/main/overlay-startup-controller')

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('SEM-F24 / J19 activates from renderer load and exact geometry without ready-to-show', async () => {
  const roles = { caption: deferred(), toolbar: deferred() }
  const calls = []
  const controller = new OverlayStartupController({
    loadRole: (role) => roles[role].promise,
    prepareAttempt: () => calls.push('prepare'),
    showReachableToolbar: () => calls.push('reachable'),
    settleGeometry: async () => { calls.push('settled'); return true },
    activateOverlays: () => calls.push('active'),
    promptRecovery: async () => 'exit',
    exitApplication: () => calls.push('exit')
  })

  controller.start()
  assert.deepEqual(calls, ['prepare', 'reachable'])
  roles.caption.resolve()
  roles.toolbar.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['prepare', 'reachable', 'settled', 'active'])
})

test('SEM-F24 / SEM-T04 / J19 retries after timeout and rejects the old attempt late completion', async () => {
  const scheduled = []
  const attempts = []
  const calls = []
  const controller = new OverlayStartupController({
    loadRole: (role) => attempts.at(-1)[role].promise,
    prepareAttempt: () => {
      attempts.push({ caption: deferred(), toolbar: deferred() })
      calls.push('prepare')
    },
    showReachableToolbar: () => calls.push('reachable'),
    settleGeometry: async () => true,
    activateOverlays: () => calls.push('active'),
    promptRecovery: async (code) => { calls.push(code); return 'retry' },
    exitApplication: () => calls.push('exit'),
    scheduleTimeout: (callback, delayMs) => {
      assert.equal(delayMs, OVERLAY_STARTUP_TIMEOUT_MS)
      scheduled.push(callback)
      return callback
    },
    cancelTimeout: () => {}
  })

  controller.start()
  scheduled[0]()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(attempts.length, 2)

  attempts[0].caption.resolve()
  attempts[0].toolbar.resolve()
  attempts[1].caption.resolve()
  attempts[1].toolbar.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((value) => value === 'active').length, 1)
  assert.equal(calls.includes('overlay-startup-timeout'), true)
})

test('SEM-F24 / SEM-T04 / J19 keeps recovery explicit when geometry cannot settle', async () => {
  const calls = []
  const controller = new OverlayStartupController({
    loadRole: async () => {},
    prepareAttempt: () => {},
    showReachableToolbar: () => calls.push('reachable'),
    settleGeometry: async () => false,
    activateOverlays: () => calls.push('active'),
    promptRecovery: async (code) => { calls.push(code); return 'exit' },
    exitApplication: () => calls.push('exit')
  })
  controller.start()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['reachable', 'overlay-startup-geometry-failed', 'exit'])
})

test('SEM-F24 / SEM-T04 / J19 exits when the recovery prompt itself fails', async () => {
  const calls = []
  const controller = new OverlayStartupController({
    loadRole: async () => {},
    prepareAttempt: () => {},
    showReachableToolbar: () => {},
    settleGeometry: async () => false,
    activateOverlays: () => calls.push('active'),
    promptRecovery: async () => { throw new Error('dialog unavailable') },
    exitApplication: () => calls.push('exit')
  })

  controller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['exit'])
})

test('SEM-F24 / SEM-T04 / J19 maps renderer load rejection to explicit recovery', async () => {
  const calls = []
  const controller = new OverlayStartupController({
    loadRole: async (role) => {
      if (role === 'caption') throw new Error('load failed')
    },
    prepareAttempt: () => {},
    showReachableToolbar: () => {},
    settleGeometry: async () => true,
    activateOverlays: () => calls.push('active'),
    promptRecovery: async (code) => { calls.push(code); return 'exit' },
    exitApplication: () => calls.push('exit')
  })

  controller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['overlay-startup-load-failed', 'exit'])
})
