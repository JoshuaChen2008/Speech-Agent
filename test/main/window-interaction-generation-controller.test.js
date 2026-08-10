'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  WindowInteractionGenerationController
} = require('../../src/main/window-interaction-generation-controller')

class FakeWindow {
  constructor (role, bounds) {
    this.role = role
    this.bounds = { ...bounds }
    this.contentBounds = null
    this.destroyed = false
    this.hidden = false
    this.minimized = false
    this.ignoreCalls = []
    this.failIgnore = false
  }

  getBounds () { return { ...this.bounds } }
  getContentBounds () { return { ...(this.contentBounds || this.bounds) } }
  isDestroyed () { return this.destroyed }
  isMinimized () { return this.minimized }
  hide () { this.hidden = true }
  restore () { this.minimized = false }
  show () { this.hidden = false }
  setIgnoreMouseEvents (ignore, options) {
    if (this.failIgnore) throw new Error(`private-path:${this.role}`)
    this.ignoreCalls.push([ignore, options])
  }
}

function controlledTimers () {
  let next = 0
  const callbacks = new Map()
  return {
    clearTimer: (id) => callbacks.delete(id),
    runAll () {
      for (const [id, callback] of [...callbacks]) {
        callbacks.delete(id)
        callback()
      }
    },
    setTimer (callback) {
      const id = ++next
      callbacks.set(id, callback)
      return id
    },
    size: () => callbacks.size
  }
}

function createHarness () {
  const windows = {
    caption: new FakeWindow('caption', { x: 100, y: 50, width: 920, height: 190 }),
    toolbar: new FakeWindow('toolbar', { x: 400, y: 70, width: 600, height: 72 }),
    settings: new FakeWindow('settings', { x: 200, y: 100, width: 880, height: 620 }),
    history: new FakeWindow('history', { x: 250, y: 120, width: 1060, height: 720 })
  }
  const sent = []
  const faults = []
  const timers = controlledTimers()
  let cursor = { x: 450, y: 100 }
  let locked = false
  const controller = new WindowInteractionGenerationController({
    clearTimer: timers.clearTimer,
    getCursorScreenPoint: () => cursor,
    getLocked: () => locked,
    getWindow: (role) => windows[role],
    onFault: (fault) => faults.push(fault),
    sendSync: (win, payload) => { sent.push([win.role, payload]); return true },
    setTimer: timers.setTimer
  })
  return {
    controller,
    faults,
    sent,
    timers,
    windows,
    setCursor: (value) => { cursor = value },
    setLocked: (value) => { locked = value }
  }
}

test('SEM-F22/SEM-F24/J17/J19: one restore generation suspends all windows then re-hits stationary local pointers', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  assert.equal(generation, 2)
  assert.deepEqual(harness.controller.getState(), { generation: 2, phase: 'suspend' })
  assert.deepEqual(harness.sent.map(([role, payload]) => [role, payload.phase, payload.generation]), [
    ['caption', 'suspend', 2], ['toolbar', 'suspend', 2],
    ['settings', 'suspend', 2], ['history', 'suspend', 2]
  ])
  assert.deepEqual(harness.windows.caption.ignoreCalls.at(-1), [true, { forward: true }])
  assert.deepEqual(harness.windows.toolbar.ignoreCalls.at(-1), [true, { forward: true }])

  assert.equal(harness.controller.resume(generation), true)
  assert.deepEqual(harness.controller.getState(), { generation: 2, phase: 'resume' })
  assert.deepEqual(harness.sent.slice(-4), [
    ['caption', { schemaVersion: 1, generation: 2, phase: 'resume', pointer: { x: 350, y: 50 } }],
    ['toolbar', { schemaVersion: 1, generation: 2, phase: 'resume', pointer: { x: 50, y: 30 } }],
    ['settings', { schemaVersion: 1, generation: 2, phase: 'resume', pointer: null }],
    ['history', { schemaVersion: 1, generation: 2, phase: 'resume', pointer: null }]
  ])
  assert.equal(harness.timers.size(), 2)

  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation: 2, ignore: false
  }), true)
  assert.equal(harness.controller.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation: 2, ignore: true
  }), true)
  assert.equal(harness.timers.size(), 0)
  assert.deepEqual(harness.faults, [])
})

test('SEM-F22/J17: toolbar pointer projection uses the content origin rather than the transparent outer origin', () => {
  const harness = createHarness()
  harness.windows.toolbar.bounds = { x: 100, y: 100, width: 600, height: 73 }
  harness.windows.toolbar.contentBounds = { x: 101, y: 101, width: 600, height: 72 }
  harness.setCursor({ x: 117, y: 117 })

  const generation = harness.controller.beginTransaction()
  assert.equal(harness.controller.resume(generation), true)
  const toolbarResume = harness.sent.findLast(([role, payload]) =>
    role === 'toolbar' && payload.phase === 'resume')

  assert.deepEqual(toolbarResume, [
    'toolbar',
    { schemaVersion: 1, generation, phase: 'resume', pointer: { x: 16, y: 16 } }
  ])
})

test('SEM-F22/SEM-F24/T04/J17/J19: stale and malformed renderer intents cannot change current native hit state', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  const before = harness.windows.caption.ignoreCalls.length

  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation: generation - 1, ignore: false
  }), false)
  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation, ignore: false, extra: true
  }), false)
  assert.equal(harness.controller.acceptGesture('caption', {
    schemaVersion: 1, generation: generation - 1
  }), false)
  assert.equal(harness.windows.caption.ignoreCalls.length, before)
  assert.deepEqual(harness.faults, [
    { role: 'caption', code: 'stale-interaction-generation' },
    { role: 'caption', code: 'stale-interaction-generation' }
  ])
})

test('SEM-F22/SEM-F24/T04/J17/J19: missing acknowledgements degrade caption through and toolbar solid until a current late acknowledgement', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  harness.timers.runAll()

  assert.deepEqual(harness.faults, [
    { role: 'caption', code: 'interaction-sync-timeout' },
    { role: 'toolbar', code: 'interaction-sync-timeout' }
  ])
  assert.equal(harness.windows.caption.ignoreCalls.at(-1)[0], true)
  assert.equal(harness.windows.toolbar.ignoreCalls.at(-1)[0], false)
  assert.equal(harness.controller.acceptGesture('toolbar', {
    schemaVersion: 1, generation
  }), false, 'timeout fallback rejects gestures until the renderer acknowledges the current hit state')

  assert.equal(harness.controller.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation, ignore: true
  }), true)
  assert.equal(harness.windows.toolbar.ignoreCalls.at(-1)[0], true)
  assert.equal(harness.controller.acceptGesture('toolbar', {
    schemaVersion: 1, generation
  }), true)
  assert.doesNotMatch(JSON.stringify(harness.faults), /private-path|[A-Z]:\\/)
})

test('SEM-F22/SEM-F24/T04/J17/J19: unavailable pointer and native pass-through failures follow fixed-priority retry paths', () => {
  const harness = createHarness()
  harness.setCursor(null)
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  assert.deepEqual(harness.faults, [
    { role: 'caption', code: 'interaction-pointer-unavailable' },
    { role: 'toolbar', code: 'interaction-pointer-unavailable' }
  ])
  assert.equal(harness.windows.caption.ignoreCalls.at(-1)[0], true)
  assert.equal(harness.windows.toolbar.ignoreCalls.at(-1)[0], false)
  assert.equal(harness.controller.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation, ignore: true
  }), false, 'pointer-unavailable fallback can only retry on reload or the next restore')
  assert.equal(harness.controller.acceptGesture('toolbar', {
    schemaVersion: 1, generation
  }), false)

  harness.setCursor({ x: 450, y: 100 })
  assert.equal(harness.controller.replay('caption'), true)
  assert.equal(harness.controller.replay('toolbar'), true)
  assert.equal(harness.timers.size(), 2)

  harness.windows.caption.failIgnore = true
  const nextGeneration = harness.controller.beginTransaction()
  assert.equal(harness.windows.caption.hidden, true)
  assert.equal(harness.controller.resume(nextGeneration), true)
  assert.equal(harness.controller.acceptGesture('caption', {
    schemaVersion: 1, generation: nextGeneration
  }), false)
  assert.deepEqual(harness.faults.at(-1), {
    role: 'caption', code: 'interaction-pass-through-failed'
  })
  assert.doesNotMatch(JSON.stringify(harness.faults), /private-path/)
})

test('SEM-F22/SEM-F24/T04/J17/J19: restoreOrShow failure hides caption, makes toolbar solid and keeps the generation suspended', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.windows.caption.hidden = false
  harness.windows.toolbar.minimized = true

  assert.equal(harness.controller.degradeForRestoreFailure(generation), true)
  assert.deepEqual(harness.controller.getState(), { generation, phase: 'suspend' })
  assert.equal(harness.windows.caption.hidden, true)
  assert.equal(harness.windows.caption.ignoreCalls.at(-1)[0], true)
  assert.equal(harness.windows.toolbar.hidden, false)
  assert.equal(harness.windows.toolbar.minimized, false)
  assert.equal(harness.windows.toolbar.ignoreCalls.at(-1)[0], false)
  assert.equal(harness.controller.acceptGesture('toolbar', {
    schemaVersion: 1, generation
  }), false)
})

test('SEM-F22/SEM-F24/T04/J17/J19: a missing native pass-through API is a fixed fail-closed fault', () => {
  const harness = createHarness()
  harness.windows.caption.setIgnoreMouseEvents = null
  const generation = harness.controller.beginTransaction()
  assert.deepEqual(harness.faults, [{
    role: 'caption', code: 'interaction-pass-through-failed'
  }])
  assert.equal(harness.windows.caption.hidden, true)
  assert.equal(harness.controller.acceptGesture('caption', {
    schemaVersion: 1, generation
  }), false)
})

test('SEM-F22/SEM-F24/T04/J17/J19: renderer reload suspends its role until current-generation replay', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation, ignore: false
  }), true)

  assert.equal(harness.controller.suspendRoleForReload('caption'), true)
  assert.equal(harness.windows.caption.ignoreCalls.at(-1)[0], true)
  assert.deepEqual(harness.sent.at(-1), [
    'caption', { schemaVersion: 1, generation, phase: 'suspend' }
  ])
  assert.equal(harness.controller.acceptGesture('caption', {
    schemaVersion: 1, generation
  }), false)
  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation, ignore: false
  }), false)

  assert.equal(harness.controller.replay('caption'), true)
  assert.deepEqual(harness.sent.at(-1), [
    'caption', { schemaVersion: 1, generation, phase: 'resume', pointer: { x: 350, y: 50 } }
  ])
  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation, ignore: false
  }), true)
  assert.equal(harness.controller.acceptGesture('caption', {
    schemaVersion: 1, generation
  }), true)
})

test('SEM-F22/SEM-F24/T04/J17/J19: renderer crash makes caption pass-through and toolbar solid until replay', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  assert.equal(harness.controller.acceptMouseThrough('caption', {
    schemaVersion: 1, generation, ignore: false
  }), true)
  assert.equal(harness.controller.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation, ignore: true
  }), true)

  assert.equal(harness.controller.failClosedAfterRendererGone('caption'), true)
  assert.equal(harness.windows.caption.ignoreCalls.at(-1)[0], true)
  assert.equal(harness.controller.acceptGesture('caption', { schemaVersion: 1, generation }), false)

  harness.windows.toolbar.hidden = true
  harness.windows.toolbar.minimized = true
  assert.equal(harness.controller.failClosedAfterRendererGone('toolbar'), true)
  assert.equal(harness.windows.toolbar.hidden, true)
  assert.equal(harness.windows.toolbar.minimized, true,
    'a renderer crash cannot turn an application minimize into a restore transaction')
  assert.equal(harness.windows.toolbar.ignoreCalls.at(-1)[0], false)
  assert.equal(harness.controller.acceptGesture('toolbar', { schemaVersion: 1, generation }), false)

  assert.equal(harness.controller.replay('caption'), true)
  assert.equal(harness.controller.replay('toolbar'), true)

  const failedSetter = createHarness()
  failedSetter.windows.toolbar.hidden = true
  failedSetter.windows.toolbar.minimized = true
  failedSetter.windows.toolbar.failIgnore = true
  assert.equal(failedSetter.controller.failClosedAfterRendererGone('toolbar'), false)
  assert.equal(failedSetter.windows.toolbar.hidden, true)
  assert.equal(failedSetter.windows.toolbar.minimized, true,
    'the native setter failure fallback also preserves the application minimize')
})

test('SEM-F22/J17: geometry settlement re-hits both overlays with the current pointer in the same generation', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  harness.controller.acceptMouseThrough('caption', { schemaVersion: 1, generation, ignore: false })
  harness.controller.acceptMouseThrough('toolbar', { schemaVersion: 1, generation, ignore: true })

  harness.windows.caption.bounds = { x: 120, y: 60, width: 940, height: 200 }
  harness.windows.toolbar.bounds = { x: 440, y: 80, width: 600, height: 72 }
  harness.setCursor({ x: 620, y: 180 })
  harness.sent.length = 0
  const captionIgnoreCount = harness.windows.caption.ignoreCalls.length
  const toolbarIgnoreCount = harness.windows.toolbar.ignoreCalls.length

  assert.equal(harness.controller.refreshPointerHits(), true)
  assert.deepEqual(harness.controller.getState(), { generation, phase: 'resume' })
  assert.deepEqual(harness.sent, [
    ['caption', { schemaVersion: 1, generation, phase: 'resume', pointer: { x: 500, y: 120 } }],
    ['toolbar', { schemaVersion: 1, generation, phase: 'resume', pointer: { x: 180, y: 100 } }]
  ])
  assert.equal(harness.windows.caption.ignoreCalls.length, captionIgnoreCount,
    'same-generation refresh must not create a temporary solid or pass-through flip')
  assert.equal(harness.windows.toolbar.ignoreCalls.length, toolbarIgnoreCount)
  assert.equal(harness.timers.size(), 2, 'both renderer acknowledgements remain fail-closed')
})

test('SEM-F22/SEM-T04/J17: geometry refresh cannot clear pointer-unavailable degradation', () => {
  const harness = createHarness()
  harness.setCursor(null)
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  harness.setCursor({ x: 450, y: 100 })
  harness.sent.length = 0
  const captionIgnore = harness.windows.caption.ignoreCalls.at(-1)
  const toolbarIgnore = harness.windows.toolbar.ignoreCalls.at(-1)

  assert.equal(harness.controller.refreshPointerHits(), false)
  assert.deepEqual(harness.sent, [])
  assert.equal(harness.timers.size(), 0)
  assert.deepEqual(harness.windows.caption.ignoreCalls.at(-1), captionIgnore)
  assert.deepEqual(harness.windows.toolbar.ignoreCalls.at(-1), toolbarIgnore)
  assert.equal(harness.controller.acceptGesture('caption', { schemaVersion: 1, generation }), false)

  assert.equal(harness.controller.replay('caption'), true)
  assert.equal(harness.controller.replay('toolbar'), true)
  assert.equal(harness.timers.size(), 2, 'renderer reload remains the registered retry boundary')
})

test('SEM-F22/SEM-T04/J17: geometry refresh cannot clear sync-timeout degradation', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  harness.timers.runAll()
  harness.sent.length = 0
  const captionIgnore = harness.windows.caption.ignoreCalls.at(-1)
  const toolbarIgnore = harness.windows.toolbar.ignoreCalls.at(-1)

  assert.equal(harness.controller.refreshPointerHits(), false)
  assert.deepEqual(harness.sent, [])
  assert.deepEqual(harness.windows.caption.ignoreCalls.at(-1), captionIgnore)
  assert.deepEqual(harness.windows.toolbar.ignoreCalls.at(-1), toolbarIgnore)
  assert.equal(harness.controller.acceptGesture('toolbar', { schemaVersion: 1, generation }), false)

  assert.equal(harness.controller.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation, ignore: true
  }), true)
  harness.sent.length = 0
  assert.equal(harness.controller.refreshPointerHits(['toolbar']), true,
    'a registered current late acknowledgement reopens only its own role')
  assert.deepEqual(harness.sent.map(([role]) => role), ['toolbar'])
})

test('SEM-F22/SEM-T04/J17: main-owned caption hit fallback obeys generation, lock and degradation boundaries', () => {
  const harness = createHarness()
  const { generation } = harness.controller.getState()
  assert.equal(harness.controller.applyCaptionNativeHit({ generation, solid: true }), true)
  assert.deepEqual(harness.windows.caption.ignoreCalls.at(-1), [false, { forward: true }])

  harness.setLocked(true)
  assert.equal(harness.controller.applyCaptionNativeHit({ generation, solid: true }), true)
  assert.deepEqual(harness.windows.caption.ignoreCalls.at(-1), [true, { forward: true }],
    'locked captions remain pass-through even if the sampled point is inside the card')
  harness.setLocked(false)

  const nextGeneration = harness.controller.beginTransaction()
  const beforeSuspend = harness.windows.caption.ignoreCalls.length
  assert.equal(harness.controller.applyCaptionNativeHit({ generation, solid: true }), false)
  assert.equal(harness.controller.applyCaptionNativeHit({ generation: nextGeneration, solid: true }), false)
  assert.equal(harness.windows.caption.ignoreCalls.length, beforeSuspend)

  harness.controller.resume(nextGeneration)
  harness.timers.runAll()
  const timeoutIgnore = harness.windows.caption.ignoreCalls.length
  assert.equal(harness.controller.applyCaptionNativeHit({ generation: nextGeneration, solid: true }), false)
  assert.equal(harness.windows.caption.ignoreCalls.length, timeoutIgnore,
    'polling cannot clear a renderer acknowledgement timeout')
  assert.equal(harness.controller.applyCaptionNativeHit({ generation: nextGeneration, solid: 'yes' }), false)
})

test('SEM-F22/T04/J17: geometry settlement cannot replay while interaction is suspended', () => {
  const harness = createHarness()
  harness.controller.beginTransaction()
  const sentBefore = harness.sent.length
  assert.equal(harness.controller.refreshPointerHits(), false)
  assert.equal(harness.sent.length, sentBefore)
})

test('SEM-F22/T04/J17: geometry settlement refreshes only distinct pointer roles', () => {
  const harness = createHarness()
  const generation = harness.controller.beginTransaction()
  harness.controller.resume(generation)
  harness.controller.acceptMouseThrough('caption', { schemaVersion: 1, generation, ignore: false })
  harness.controller.acceptMouseThrough('toolbar', { schemaVersion: 1, generation, ignore: true })
  harness.sent.length = 0

  assert.equal(harness.controller.refreshPointerHits(['toolbar']), true)
  assert.deepEqual(harness.sent.map(([role]) => role), ['toolbar'])
  assert.throws(() => harness.controller.refreshPointerHits([]), /refresh roles/)
  assert.throws(() => harness.controller.refreshPointerHits(['toolbar', 'toolbar']), /refresh roles/)
  assert.throws(() => harness.controller.refreshPointerHits(['settings']), /refresh roles/)
})
