'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CaptionNativeHitController
} = require('../../src/main/caption-native-hit-controller')
const {
  ToolbarLayoutState
} = require('../../src/main/window-layout-contract')

function controlledScheduler () {
  let nextId = 0
  const callbacks = new Map()
  return {
    clearTimer: (id) => callbacks.delete(id),
    runNext () {
      const entry = callbacks.entries().next().value
      assert.ok(entry, 'caption native hit polling must remain scheduled')
      callbacks.delete(entry[0])
      entry[1]()
    },
    setTimer (callback) {
      const id = ++nextId
      callbacks.set(id, callback)
      return id
    },
    size: () => callbacks.size
  }
}

function createHarness () {
  const scheduler = controlledScheduler()
  const layout = new ToolbarLayoutState()
  layout.acceptReport({
    generation: 1,
    rect: { x: 184, y: 16, width: 400, height: 40 }
  })
  const caption = {
    bounds: { x: 100, y: 80, width: 920, height: 190 },
    destroyed: false,
    minimized: false,
    visible: true,
    getBounds () { return { ...this.bounds } },
    isDestroyed () { return this.destroyed },
    isMinimized () { return this.minimized },
    isVisible () { return this.visible }
  }
  let cursor = { x: 110, y: 150 }
  let interactionState = { generation: 1, phase: 'resume' }
  let locked = false
  let gestureActive = false
  let applyAccepted = true
  const applications = []
  const controller = new CaptionNativeHitController({
    applyNativeHit: (value) => { applications.push({ ...value }); return applyAccepted },
    clearTimer: scheduler.clearTimer,
    getCaptionWindow: () => caption,
    getCursorScreenPoint: () => ({ ...cursor }),
    getInteractionState: () => ({ ...interactionState }),
    getLocked: () => locked,
    getToolbarOverlap: () => layout.getOverlap(),
    isGestureActive: () => gestureActive,
    setTimer: scheduler.setTimer
  })
  return {
    applications,
    caption,
    controller,
    layout,
    scheduler,
    setApplyAccepted: (value) => { applyAccepted = value },
    setCursor: (value) => { cursor = value },
    setGestureActive: (value) => { gestureActive = value },
    setInteractionState: (value) => { interactionState = value },
    setLocked: (value) => { locked = value }
  }
}

test('SEM-F22/J17: main polling re-arms an unlocked caption without renderer mouse movement and deduplicates native writes', () => {
  const harness = createHarness()
  assert.equal(harness.controller.start(), true)
  assert.deepEqual(harness.applications, [{ generation: 1, solid: false }])
  assert.equal(harness.scheduler.size(), 1)

  harness.setCursor({ x: 300, y: 200 })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: true })
  const afterCardEntry = harness.applications.length
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, afterCardEntry,
    'an unchanged caption hit cannot repeat the native setter')

  harness.setCursor({ x: 700, y: 125 })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: false },
    'the toolbar overlap keeps the caption pass-through')

  harness.setCursor({ x: 700, y: 115 })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: true },
    'the ordinary lane next to the toolbar remains draggable')

  harness.layout.acceptReport({
    generation: 1,
    rect: { x: 184, y: 0, width: 400, height: 40 }
  })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: false },
    'a changed toolbar contour re-hits the stationary pointer')
  harness.layout.acceptReport({
    generation: 1,
    rect: { x: 184, y: 16, width: 400, height: 40 }
  })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: true })

  harness.setCursor({ x: 300, y: 200 })
  harness.scheduler.runNext()
  harness.caption.bounds.x = 400
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: false },
    'changed caption bounds invalidate the previous hit result')
  harness.caption.bounds.x = 100
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: true })
  assert.equal(harness.controller.start(), false, 'duplicate starts cannot create another timer')
})

test('SEM-F22/SEM-T04/J17: a rejected native write is retried and never enters the deduplication cache', () => {
  const harness = createHarness()
  harness.setApplyAccepted(false)
  harness.controller.start()
  assert.equal(harness.applications.length, 1)
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, 2,
    'a pending generation acknowledgement must leave the desired hit retryable')

  harness.setApplyAccepted(true)
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, 3)
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, 3,
    'deduplication starts only after the generation controller accepts the write')
})

test('SEM-F22/SEM-T04/J17: polling yields to gestures and lifecycle generations, then re-evaluates after settlement', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.setCursor({ x: 300, y: 200 })
  harness.scheduler.runNext()
  const beforeGesture = harness.applications.length

  harness.setGestureActive(true)
  harness.setCursor({ x: 110, y: 150 })
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, beforeGesture,
    'an active drag keeps its current native hit surface')
  harness.setGestureActive(false)
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 1, solid: false })

  harness.setInteractionState({ generation: 2, phase: 'suspend' })
  harness.setCursor({ x: 300, y: 200 })
  const beforeSuspend = harness.applications.length
  harness.scheduler.runNext()
  assert.equal(harness.applications.length, beforeSuspend,
    'suspend remains owned by the window interaction generation controller')
  harness.setInteractionState({ generation: 2, phase: 'resume' })
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 2, solid: true })

  harness.setLocked(true)
  harness.scheduler.runNext()
  assert.deepEqual(harness.applications.at(-1), { generation: 2, solid: false })
  assert.equal(harness.controller.stop(), true)
  assert.equal(harness.scheduler.size(), 0)
  assert.equal(harness.controller.stop(), false)
})

test('SEM-F22/SEM-T04/J17: unavailable windows, pointers and geometry fail closed without stopping the bounded poll', () => {
  for (const mutate of [
    (harness) => { harness.caption.visible = false },
    (harness) => { harness.caption.destroyed = true },
    (harness) => { harness.caption.minimized = true },
    (harness) => { harness.setCursor({ x: Number.NaN, y: 100 }) },
    (harness) => { harness.layout.getOverlap = () => null }
  ]) {
    const harness = createHarness()
    mutate(harness)
    assert.equal(harness.controller.start(), true)
    assert.deepEqual(harness.applications, [{ generation: 1, solid: false }])
    assert.equal(harness.scheduler.size(), 1)
    harness.controller.stop()
  }
})
