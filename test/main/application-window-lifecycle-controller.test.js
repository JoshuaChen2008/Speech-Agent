'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  ApplicationWindowLifecycleController,
  AUXILIARY_BOUNDS_TOLERANCE_DIP,
  POST_RESTORE_FINAL_COMMIT_MS,
  POST_RESTORE_MAX_MS,
  POST_RESTORE_QUIET_MS,
  PRIMARY_WINDOW_TITLE,
  WINDOWS_APP_USER_MODEL_ID,
  overlayApplicationOptions,
  restoreBoundsEquivalent
} = require('../../src/main/application-window-lifecycle-controller')
const {
  bindToolbarDockInvariant,
  toolbarViewportBoundsFor,
  toolbarWindowViewportBounds
} = require('../../src/main/toolbar-dock-invariant')

const root = path.resolve(__dirname, '..', '..')

class FakeWindow extends EventEmitter {
  constructor (role, calls, {
    visible = true,
    minimized = false,
    focused = false,
    bounds = { x: 10, y: 20, width: 300, height: 100 }
  } = {}) {
    super()
    this.role = role
    this.calls = calls
    this.visible = visible
    this.minimized = minimized
    this.focused = focused
    this.destroyed = false
    this.bounds = { ...bounds }
    this.restoredBounds = null
    this.delayedRestoredBounds = null
    this.normalizeBounds = null
    this.setBoundsCalls = 0
    this.failOn = new Set()
  }

  invoke (name) {
    this.calls.push(`${this.role}.${name}`)
    if (this.failOn.has(name)) throw new Error(`private-path:${this.role}:${name}`)
  }

  isDestroyed () { return this.destroyed }
  isVisible () { return this.visible }
  isMinimized () { return this.minimized }
  isFocused () { return this.focused }
  getBounds () { return { ...this.bounds } }

  setBounds (bounds) {
    this.invoke('setBounds')
    this.setBoundsCalls += 1
    this.bounds = this.normalizeBounds ? this.normalizeBounds({ ...bounds }) : { ...bounds }
  }

  hide () {
    this.invoke('hide')
    this.visible = false
    this.focused = false
  }

  show () {
    this.invoke('show')
    this.visible = true
  }

  showInactive () {
    this.invoke('showInactive')
    this.visible = true
  }

  minimize () {
    this.invoke('minimize')
    this.minimized = true
    this.visible = false
    this.focused = false
    this.emit('minimize')
  }

  restore () {
    this.invoke('restore')
    this.minimized = false
    this.visible = true
    if (this.restoredBounds) this.bounds = { ...this.restoredBounds }
    if (this.delayedRestoredBounds) {
      const delayedBounds = { ...this.delayedRestoredBounds }
      setImmediate(() => { this.bounds = delayedBounds })
    }
    this.emit('restore')
  }

  focus () {
    this.invoke('focus')
    this.focused = true
  }

  destroy () {
    this.destroyed = true
    this.visible = false
    this.focused = false
    this.emit('closed')
  }
}

class FakeScheduler {
  constructor () {
    this.now = 0
    this.nextId = 1
    this.tasks = new Map()
  }

  schedule = (callback, delayMs = 0) => {
    const id = this.nextId++
    this.tasks.set(id, { callback, due: this.now + delayMs, id })
    return id
  }

  cancel = (id) => { this.tasks.delete(id) }

  advance (durationMs) {
    const target = this.now + durationMs
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0]
      if (!next) break
      this.tasks.delete(next.id)
      this.now = next.due
      next.callback()
    }
    this.now = target
  }

  pendingCount () { return this.tasks.size }
}

function createHarness ({
  settingsFocused = true,
  schedulePostRestore = setImmediate,
  cancelPostRestore = clearImmediate,
  suspendGeometryCorrections = () => {},
  getPrimaryRestoreBounds = (primary) => toolbarViewportBoundsFor(toolbarWindowViewportBounds(primary)),
  onResumeInteractions = () => true
} = {}) {
  const calls = []
  const faults = []
  const caption = new FakeWindow('caption', calls, {
    bounds: { x: 100, y: 70, width: 920, height: 190 }
  })
  const toolbar = new FakeWindow('toolbar', calls, {
    focused: !settingsFocused,
    bounds: { x: 404, y: 86, width: 600, height: 72 }
  })
  const settings = new FakeWindow('settings', calls, {
    focused: settingsFocused,
    bounds: { x: 320, y: 180, width: 880, height: 620 }
  })
  const history = new FakeWindow('history', calls, {
    visible: false,
    minimized: true,
    bounds: { x: 260, y: 140, width: 1060, height: 720 }
  })
  let stopCount = 0
  let stackCount = 0
  let interactionGeneration = 1
  const resumedGenerations = []
  const resumedPrimaryBounds = []
  const degradedGenerations = []
  const controller = new ApplicationWindowLifecycleController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getSettingsWindow: () => settings,
    getHistoryWindow: () => history,
    stopInteractions: () => { stopCount += 1 },
    beginInteractionTransaction: () => { interactionGeneration += 1; return interactionGeneration },
    resumeInteractions: (generation, primaryBounds) => {
      resumedGenerations.push(generation)
      resumedPrimaryBounds.push(primaryBounds ? { ...primaryBounds } : null)
      return onResumeInteractions(generation, primaryBounds)
    },
    degradeInteractions: (generation) => { degradedGenerations.push(generation); return true },
    restoreWindowStack: () => { stackCount += 1 },
    schedulePostRestore,
    cancelPostRestore,
    suspendGeometryCorrections,
    getPrimaryRestoreBounds,
    onFault: (fault) => faults.push(fault)
  })
  controller.bindPrimaryWindow(toolbar)
  controller.bindAuxiliaryWindow(settings, 'settings')
  controller.bindAuxiliaryWindow(history, 'history')
  return {
    calls,
    caption,
    controller,
    faults,
    history,
    settings,
    toolbar,
    getStackCount: () => stackCount,
    getStopCount: () => stopCount,
    getInteractionGeneration: () => interactionGeneration,
    getResumedGenerations: () => [...resumedGenerations],
    getResumedPrimaryBounds: () => resumedPrimaryBounds.map((bounds) => bounds ? { ...bounds } : null),
    getDegradedGenerations: () => [...degradedGenerations]
  }
}

test('SEM-F22/SEM-F24/J17/J19: minimize and restore use separate generations while suspend and resume share the restore generation', async () => {
  const harness = createHarness()
  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.getInteractionGeneration(), 2)
  assert.deepEqual(harness.getResumedGenerations(), [])

  harness.toolbar.restore()
  assert.equal(harness.getInteractionGeneration(), 3)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/J19: app minimize and taskbar restore preserve the visible window set, bounds and focus', () => {
  const harness = createHarness()
  const windows = [harness.caption, harness.toolbar, harness.settings, harness.history]
  const beforeBounds = windows.map((win) => win.getBounds())

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.caption.visible, false)
  assert.equal(harness.toolbar.minimized, true)
  assert.equal(harness.settings.minimized, true)
  assert.equal(harness.history.minimized, true, 'an already minimized auxiliary stays outside the visible set')

  harness.toolbar.restore()
  assert.equal(harness.caption.visible, true)
  assert.equal(harness.toolbar.minimized, false)
  assert.equal(harness.toolbar.visible, true)
  assert.equal(harness.settings.minimized, false)
  assert.equal(harness.settings.visible, true)
  assert.equal(harness.settings.focused, true)
  assert.equal(harness.history.minimized, true)
  assert.equal(harness.history.visible, false)
  assert.deepEqual(windows.map((win) => win.getBounds()), beforeBounds)
  assert.equal(harness.getStopCount(), 2)
  assert.equal(harness.getStackCount(), 1)
  assert.deepEqual(harness.faults, [])
})

test('SEM-F22/SEM-F24/J17/J19: toolbar restore validates content bounds instead of transparent outer rounding', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.toolbar.getBounds()
  harness.toolbar.contentBounds = { ...expected }
  harness.toolbar.bounds = { ...expected, height: expected.height + 1 }
  harness.toolbar.getContentBounds = () => ({ ...harness.toolbar.contentBounds })
  harness.toolbar.setContentBounds = (bounds) => {
    harness.toolbar.invoke('setContentBounds')
    harness.toolbar.setBoundsCalls += 1
    harness.toolbar.contentBounds = { ...bounds }
    harness.toolbar.bounds = { ...bounds, height: bounds.height + 1 }
  }

  assert.equal(harness.controller.minimize(), true)
  harness.toolbar.contentBounds = { ...expected, x: expected.x + 40, width: expected.width + 2 }
  harness.toolbar.bounds = { ...harness.toolbar.contentBounds, height: expected.height + 1 }
  assert.equal(harness.controller.restore(), true)
  assert.deepEqual(harness.toolbar.getContentBounds(), expected)
  assert.deepEqual(harness.toolbar.getBounds(), { ...expected, height: expected.height + 1 })
  assert.equal(harness.calls.includes('toolbar.setContentBounds'), true)
  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.getResumedGenerations(), [3])
  assert.deepEqual(harness.faults, [])
})

test('SEM-F22/SEM-F24/T04/J17/J19: toolbar outer drift above one DIP cannot resume the restore generation', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.toolbar.getBounds()
  harness.toolbar.contentBounds = { ...expected }
  harness.toolbar.bounds = { ...expected, height: expected.height + 2 }
  harness.toolbar.getContentBounds = () => ({ ...harness.toolbar.contentBounds })
  harness.toolbar.setContentBounds = (bounds) => {
    harness.toolbar.invoke('setContentBounds')
    harness.toolbar.setBoundsCalls += 1
    harness.toolbar.contentBounds = { ...bounds }
    harness.toolbar.bounds = { ...bounds, height: bounds.height + 2 }
  }

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  scheduler.advance(POST_RESTORE_MAX_MS + POST_RESTORE_FINAL_COMMIT_MS)

  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F22/SEM-F24/J17/J19: minimize settles an active gesture before capturing the restore baseline', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const settled = { x: 447, y: 113, width: 600, height: 72 }
  const order = []
  harness.controller.stopInteractions = () => {
    order.push('stop')
    harness.toolbar.bounds = { ...settled }
  }
  harness.controller.getPrimaryRestoreBounds = (primary) => {
    order.push('capture')
    return primary.getBounds()
  }

  assert.equal(harness.controller.minimize(), true)
  assert.deepEqual(order, ['stop', 'capture'])
  harness.toolbar.bounds = { x: 1, y: 2, width: 603, height: 75 }
  assert.equal(harness.controller.restore(), true)
  assert.deepEqual(harness.toolbar.getBounds(), settled)
  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/J19: a native minimize and an auxiliary taskbar restore operate on the same app window set', () => {
  const harness = createHarness()

  harness.toolbar.minimize()
  assert.equal(harness.caption.visible, false)
  assert.equal(harness.settings.minimized, true)

  harness.settings.restore()
  assert.equal(harness.toolbar.minimized, false)
  assert.equal(harness.toolbar.visible, true)
  assert.equal(harness.caption.visible, true)
  assert.equal(harness.settings.visible, true)
  assert.deepEqual(harness.faults, [])
})

test('SEM-F24/J19: restore corrects native primary-window bounds drift before restacking', () => {
  const harness = createHarness()
  const expected = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  harness.toolbar.restoredBounds = { ...expected, x: expected.x + 48 }
  harness.toolbar.restore()

  assert.deepEqual(harness.toolbar.getBounds(), expected)
  assert.equal(harness.calls.includes('toolbar.setBounds'), true)
  assert.deepEqual(harness.faults, [])
})

test('SEM-F22/SEM-F24/J17/J19: minimize never captures native toolbar size drift as the restore baseline', () => {
  const harness = createHarness()
  const independentPosition = { x: 731, y: 241 }
  harness.toolbar.bounds = {
    ...independentPosition,
    width: 603,
    height: 75
  }

  assert.equal(harness.controller.minimize(), true)
  harness.toolbar.restoredBounds = { x: 20, y: 30, width: 616, height: 88 }
  harness.toolbar.restore()

  assert.deepEqual(harness.toolbar.getBounds(), {
    ...independentPosition,
    width: 600,
    height: 72
  })
})

test('SEM-F24/J19: restore corrects native primary-window bounds drift after the restore event settles', async () => {
  const harness = createHarness()
  const expected = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  harness.toolbar.delayedRestoredBounds = { ...expected, x: expected.x + 48 }
  harness.toolbar.restore()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(harness.toolbar.getBounds(), expected)
  assert.equal(harness.calls.includes('toolbar.setBounds'), true)
  assert.deepEqual(harness.faults, [])
})

test('SEM-F24/J19: the bounded restore settlement corrects late move and resize events before resume', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const toolbarExpected = harness.toolbar.getBounds()
  const settingsExpected = harness.settings.getBounds()

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  assert.equal(scheduler.pendingCount(), 2, 'quiet and maximum deadlines are both armed')

  harness.toolbar.bounds = { ...toolbarExpected, x: toolbarExpected.x + 23 }
  harness.toolbar.emit('move')
  assert.deepEqual(harness.toolbar.getBounds(), toolbarExpected)

  harness.settings.bounds = { ...settingsExpected, width: settingsExpected.width + 17 }
  harness.settings.emit('resize')
  assert.deepEqual(harness.settings.getBounds(), settingsExpected)
  assert.deepEqual(harness.getResumedGenerations(), [], 'resume waits for the settlement deadline')

  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [3])
  assert.equal(scheduler.pendingCount(), 0)
  harness.toolbar.bounds = { ...toolbarExpected, x: toolbarExpected.x + 9 }
  harness.toolbar.emit('move')
  assert.equal(harness.toolbar.getBounds().x, toolbarExpected.x + 9,
    'temporary settlement listeners are removed after resume')
})

test('SEM-F24/J19: an event at quiet minus one invalidates the old quiet deadline', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.history.getBounds()
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  harness.history.bounds = { ...expected, x: expected.x + 13 }
  harness.history.emit('move')

  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/J19: a quiet callback that corrects bounds waits through another full quiet period', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  harness.toolbar.bounds = { ...expected, width: expected.width + 5 }
  scheduler.advance(1)

  assert.deepEqual(harness.toolbar.getBounds(), expected)
  assert.deepEqual(harness.getResumedGenerations(), [], 'the correcting callback cannot resume immediately')
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/J19: an asynchronous geometry event caused by correction resets quiet without recursion', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  harness.toolbar.bounds = { ...expected, height: expected.height + 4 }
  scheduler.schedule(() => harness.toolbar.emit('resize'), 2)
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(2)
  scheduler.advance(POST_RESTORE_QUIET_MS - 2)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/J19: continuous native events settle exactly once at the maximum deadline', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.history.getBounds()
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  for (let elapsed = 200; elapsed <= 800; elapsed += 200) {
    scheduler.advance(200)
    harness.history.bounds = { ...expected, x: expected.x + elapsed }
    harness.history.emit('move')
  }
  scheduler.advance(POST_RESTORE_MAX_MS - 801)
  harness.history.bounds = { ...expected, width: expected.width + 9 }
  harness.history.emit('resize')
  assert.deepEqual(harness.getResumedGenerations(), [])

  scheduler.advance(1)
  assert.deepEqual(harness.history.getBounds(), expected)
  assert.deepEqual(harness.getResumedGenerations(), [3])
  assert.equal(scheduler.pendingCount(), 0)
  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.getResumedGenerations(), [3], 'quiet/max convergence resumes only once')
})

test('SEM-F24/J19: final correction waits for an asynchronous native commit before resume', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.history.getBounds()
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  for (let elapsed = 200; elapsed <= 800; elapsed += 200) {
    scheduler.advance(200)
    harness.history.bounds = { ...expected, x: expected.x + elapsed }
    harness.history.emit('move')
  }
  scheduler.advance(199)
  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    scheduler.schedule(() => {
      harness.history.bounds = { ...bounds }
      harness.history.emit('resize')
    }, 20)
  }
  harness.history.bounds = { ...expected, width: expected.width + 9 }
  harness.history.emit('resize')

  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(19)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.history.getBounds(), expected)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(POST_RESTORE_FINAL_COMMIT_MS - 21)
  harness.history.emit('move')
  assert.deepEqual(harness.getResumedGenerations(), [], 'a late event cannot extend or bypass the fixed confirmation')
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [3])
})

test('SEM-F24/SEM-T04/J19: final commit confirmation observes late drift without issuing another write', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.history.getBounds()
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  for (let elapsed = 200; elapsed <= 800; elapsed += 200) {
    scheduler.advance(200)
    harness.history.bounds = { ...expected, x: expected.x + elapsed }
    harness.history.emit('move')
  }
  scheduler.advance(199)
  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    scheduler.schedule(() => {
      harness.history.bounds = { ...bounds }
      harness.history.emit('resize')
    }, 20)
  }
  harness.history.bounds = { ...expected, width: expected.width + 9 }
  harness.history.emit('resize')
  scheduler.advance(1)
  scheduler.advance(20)
  assert.deepEqual(harness.history.getBounds(), expected)
  assert.deepEqual(harness.getResumedGenerations(), [])

  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    harness.history.bounds = { ...bounds }
  }
  scheduler.advance(POST_RESTORE_FINAL_COMMIT_MS - 21)
  const writesBeforeLateDrift = harness.history.setBoundsCalls
  harness.history.bounds = { ...expected, x: expected.x + 17 }
  harness.history.emit('move')
  harness.history.emit('resize')
  assert.equal(harness.history.setBoundsCalls, writesBeforeLateDrift,
    'the whole fixed confirmation period is observation-only')

  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F22/SEM-F24/SEM-T04/J17/J19: final confirmation freezes the real toolbar dock corrector', () => {
  const scheduler = new FakeScheduler()
  let dockBinding = null
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel,
    suspendGeometryCorrections: () => dockBinding?.suspendCorrection(),
    getPrimaryRestoreBounds: (primary) => dockBinding?.getExpectedBounds() ||
      toolbarViewportBoundsFor(toolbarWindowViewportBounds(primary)),
    onResumeInteractions: (_generation, primaryBounds) => dockBinding
      ? dockBinding.commitBounds(primaryBounds || null)
      : true
  })
  const expectedToolbar = harness.toolbar.getBounds()
  const expectedHistory = harness.history.getBounds()
  harness.toolbar.contentBounds = { ...expectedToolbar }
  harness.toolbar.getContentBounds = () => ({ ...harness.toolbar.contentBounds })
  harness.toolbar.setContentBoundsCalls = 0
  harness.toolbar.setContentBounds = (bounds) => {
    harness.toolbar.invoke('setContentBounds')
    harness.toolbar.setContentBoundsCalls += 1
    harness.toolbar.contentBounds = { ...bounds }
    harness.toolbar.bounds = { ...bounds }
  }
  dockBinding = bindToolbarDockInvariant({
    toolbar: harness.toolbar,
    getDockBounds: () => ({ ...expectedToolbar }),
    setDockBounds: (bounds) => harness.toolbar.setContentBounds(bounds),
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel
  })
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  for (let elapsed = 200; elapsed <= 800; elapsed += 200) {
    scheduler.advance(200)
    harness.history.bounds = { ...expectedHistory, x: expectedHistory.x + elapsed }
    harness.history.emit('move')
  }
  scheduler.advance(199)
  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    scheduler.schedule(() => {
      harness.history.bounds = { ...bounds }
      harness.history.emit('resize')
    }, 20)
  }
  harness.history.bounds = { ...expectedHistory, width: expectedHistory.width + 9 }
  harness.history.emit('resize')
  scheduler.advance(1)
  scheduler.advance(20)
  assert.deepEqual(harness.getResumedGenerations(), [])

  scheduler.advance(POST_RESTORE_FINAL_COMMIT_MS - 21)
  const toolbarWritesBeforeLateDrift = harness.toolbar.setContentBoundsCalls
  harness.toolbar.contentBounds = { ...expectedToolbar, x: expectedToolbar.x + 17 }
  harness.toolbar.bounds = { ...expectedToolbar, x: expectedToolbar.x + 17 }
  harness.toolbar.emit('move')
  harness.toolbar.emit('resize')
  assert.equal(harness.toolbar.setContentBoundsCalls, toolbarWritesBeforeLateDrift,
    'every geometry writer stays frozen during final confirmation')

  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.equal(scheduler.pendingCount(), 0)

  assert.deepEqual(dockBinding.getExpectedBounds(), expectedToolbar,
    'the failed native observation never replaces the last legal toolbar position')
  harness.toolbar.setContentBounds = (bounds) => {
    harness.toolbar.invoke('setContentBounds')
    harness.toolbar.setContentBoundsCalls += 1
    scheduler.schedule(() => {
      harness.toolbar.contentBounds = { ...bounds }
      harness.toolbar.bounds = { ...bounds }
      harness.toolbar.emit('resize')
    }, 20)
  }
  assert.equal(harness.controller.restoreOrShow(), true)
  scheduler.advance(19)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.toolbar.getContentBounds(), expectedToolbar)
  scheduler.advance(POST_RESTORE_QUIET_MS - 21)
  assert.deepEqual(harness.getResumedGenerations(), [],
    'retry stays suspended until a full quiet period follows the native commit')
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [],
    'the obsolete pre-commit quiet deadline cannot resume the retry')
  scheduler.advance(20)
  assert.deepEqual(harness.getResumedGenerations(), [4])
  assert.deepEqual(harness.getResumedPrimaryBounds(), [expectedToolbar])
  assert.deepEqual(dockBinding.getExpectedBounds(), expectedToolbar)

  harness.toolbar.setContentBounds = (bounds) => {
    harness.toolbar.invoke('setContentBounds')
    harness.toolbar.setContentBoundsCalls += 1
    harness.toolbar.contentBounds = { ...bounds }
    harness.toolbar.bounds = { ...bounds }
  }
  const writesBeforeReactivatedCorrection = harness.toolbar.setContentBoundsCalls
  harness.toolbar.contentBounds = { ...expectedToolbar, x: expectedToolbar.x + 5 }
  harness.toolbar.bounds = { ...expectedToolbar, x: expectedToolbar.x + 5 }
  harness.toolbar.emit('move')
  assert.equal(harness.toolbar.setContentBoundsCalls, writesBeforeReactivatedCorrection + 1)
  assert.deepEqual(harness.toolbar.getContentBounds(), expectedToolbar)
  dockBinding.unbind()
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F24/SEM-T04/J19: retry preserves caption and auxiliary bounds from before final-confirmation failure', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expectedCaption = harness.caption.getBounds()
  const expectedHistory = harness.history.getBounds()
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  for (let elapsed = 200; elapsed <= 800; elapsed += 200) {
    scheduler.advance(200)
    harness.history.bounds = { ...expectedHistory, x: expectedHistory.x + elapsed }
    harness.history.emit('move')
  }
  scheduler.advance(199)
  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    scheduler.schedule(() => {
      harness.history.bounds = { ...bounds }
      harness.history.emit('resize')
    }, 20)
  }
  harness.history.bounds = { ...expectedHistory, width: expectedHistory.width + 9 }
  harness.history.emit('resize')
  scheduler.advance(1)
  scheduler.advance(20)
  scheduler.advance(POST_RESTORE_FINAL_COMMIT_MS - 21)

  harness.caption.bounds = { ...expectedCaption, x: expectedCaption.x + 17 }
  harness.history.bounds = { ...expectedHistory, y: expectedHistory.y + 13 }
  harness.caption.emit('move')
  harness.history.emit('resize')
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.equal(scheduler.pendingCount(), 0)

  harness.settings.destroy()
  harness.caption.visible = false
  harness.history.setBounds = (bounds) => {
    harness.history.invoke('setBounds')
    harness.history.setBoundsCalls += 1
    harness.history.bounds = { ...bounds }
  }
  assert.equal(harness.controller.restoreOrShow(), true)
  assert.equal(harness.caption.visible, true)
  assert.equal(harness.settings.visible, false)
  assert.deepEqual(harness.caption.getBounds(), expectedCaption)
  assert.deepEqual(harness.history.getBounds(), expectedHistory)
  scheduler.advance(POST_RESTORE_QUIET_MS - 1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [4])
})

test('SEM-F24/J19: closing an auxiliary during active settlement cannot block the primary recovery', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  harness.history.visible = true
  harness.history.minimized = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  harness.history.destroy()
  scheduler.advance(POST_RESTORE_QUIET_MS)

  assert.deepEqual(harness.getResumedGenerations(), [3])
  assert.deepEqual(harness.getDegradedGenerations(), [])
  assert.deepEqual(harness.faults, [])
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F24/J19: only auxiliary windows accept the one-DIP physical-pixel equivalence', () => {
  const expected = { x: 100, y: 80, width: 1060, height: 720 }
  const rounded = { x: 101, y: 79, width: 1059, height: 721 }
  assert.equal(AUXILIARY_BOUNDS_TOLERANCE_DIP, 1)
  assert.equal(restoreBoundsEquivalent('history', rounded, expected), true)
  assert.equal(restoreBoundsEquivalent('settings', rounded, expected), true)
  assert.equal(restoreBoundsEquivalent('history', { ...rounded, width: 1058 }, expected), false)
  assert.equal(restoreBoundsEquivalent('caption', rounded, expected), false)
  assert.equal(restoreBoundsEquivalent('toolbar', rounded, expected), false)
})

test('SEM-F24/J19: auxiliary one-DIP normalization settles at quiet and does not accumulate over 20 restores', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  harness.history.visible = true
  harness.history.minimized = false
  const expected = harness.history.getBounds()
  harness.history.normalizeBounds = (bounds) => ({
    ...bounds,
    width: bounds.width - 1,
    height: bounds.height + 1
  })

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  harness.history.bounds = { ...expected, x: expected.x + 11, width: expected.width + 7 }
  harness.history.emit('move')
  harness.history.emit('resize')
  const normalized = harness.history.getBounds()
  assert.equal(restoreBoundsEquivalent('history', normalized, expected), true)
  const correctionsBeforeQuiet = harness.history.setBoundsCalls

  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.getResumedGenerations(), [3])
  assert.equal(harness.history.setBoundsCalls, correctionsBeforeQuiet,
    'one-DIP equivalence does not issue another correction or reset quiet')

  for (let round = 0; round < 20; round += 1) {
    assert.equal(harness.controller.minimize(), true)
    assert.equal(harness.controller.restore(), true)
    scheduler.advance(POST_RESTORE_QUIET_MS)
    assert.deepEqual(harness.history.getBounds(), normalized, `restore round ${round} must remain idempotent`)
  }
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F24/SEM-T04/J19: irreducible overlay drift degrades at max instead of inheriting auxiliary tolerance', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const expected = harness.caption.getBounds()
  harness.caption.normalizeBounds = (bounds) => ({ ...bounds, width: bounds.width - 1 })

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  harness.caption.bounds = { ...expected, x: expected.x + 9 }
  harness.caption.emit('move')

  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.getResumedGenerations(), [], 'overlay one-DIP mismatch keeps settling')
  scheduler.advance(POST_RESTORE_MAX_MS - POST_RESTORE_QUIET_MS - 1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  scheduler.advance(1)
  assert.deepEqual(harness.getResumedGenerations(), [])
  const correctionsAtMaximum = harness.caption.setBoundsCalls
  scheduler.advance(POST_RESTORE_FINAL_COMMIT_MS)
  assert.equal(harness.caption.setBoundsCalls, correctionsAtMaximum,
    'the final native-commit deadline is read-only')
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.equal(scheduler.pendingCount(), 0)
  assert.ok(harness.caption.setBoundsCalls >= 2)
})

test('SEM-F24/J19: an auxiliary that becomes ready while minimized is deferred into the restore set', () => {
  const harness = createHarness({ settingsFocused: false })
  harness.settings.visible = false

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.showAuxiliaryWindow(harness.settings, 'settings'), false)
  assert.equal(harness.settings.visible, false)

  harness.toolbar.restore()
  assert.equal(harness.settings.visible, true)
  assert.equal(harness.settings.focused, true)
})

test('SEM-F24/J19: a minimize failure rolls back to a taskbar-reachable primary with fixed diagnostics', () => {
  const harness = createHarness()
  harness.settings.failOn.add('minimize')

  assert.equal(harness.controller.minimize(), false)
  assert.equal(harness.toolbar.visible, true)
  assert.equal(harness.toolbar.minimized, false)
  assert.equal(harness.caption.visible, true)
  assert.equal(harness.settings.visible, true)
  assert.deepEqual(harness.faults, [{ role: 'application', code: 'minimize-failed' }])
  assert.doesNotMatch(JSON.stringify(harness.faults), /private-path/)
})

test('SEM-F22/SEM-F24/T04/J17/J19: a failed minimize rollback degrades the same interaction generation for retry', () => {
  const harness = createHarness()
  harness.settings.failOn.add('minimize')
  harness.toolbar.failOn.add('show')

  assert.equal(harness.controller.minimize(), false)
  assert.equal(harness.toolbar.visible, true)
  assert.deepEqual(harness.getDegradedGenerations(), [2])
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'minimize-failed' },
    { role: 'application', code: 'minimize-rollback-failed' }
  ])
  assert.doesNotMatch(JSON.stringify(harness.faults), /private-path/)
})

test('SEM-F24/J19: a restore failure exposes the primary and keeps the same window set retryable', () => {
  const harness = createHarness()
  assert.equal(harness.controller.minimize(), true)
  harness.settings.failOn.add('restore')

  assert.equal(harness.controller.restore(), false)
  assert.equal(harness.toolbar.visible, true)
  assert.equal(harness.toolbar.minimized, false)
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.faults, [{ role: 'application', code: 'restore-failed' }])

  harness.settings.failOn.delete('restore')
  assert.equal(harness.controller.restore(), true)
  assert.equal(harness.caption.visible, true)
  assert.equal(harness.settings.visible, true)
  assert.equal(harness.settings.minimized, false)
})

test('SEM-F22/SEM-F24/T04/J17/J19: a newer restore transaction invalidates an older delayed bounds correction', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })
  const original = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)

  harness.toolbar.bounds = { ...original, x: original.x + 31 }
  assert.equal(harness.controller.restoreOrShow(), true)
  scheduler.advance(POST_RESTORE_QUIET_MS)
  assert.deepEqual(harness.toolbar.getBounds(), original,
    'the newer transaction reuses the pending legal baseline instead of recapturing drift')
  assert.deepEqual(harness.getResumedGenerations(), [4])
  assert.equal(scheduler.pendingCount(), 0)
})

test('SEM-F22/SEM-F24/T04/J17/J19: post-restore bounds failure degrades instead of resuming hit testing', () => {
  const scheduler = new FakeScheduler()
  const harness = createHarness({
    schedulePostRestore: scheduler.schedule,
    cancelPostRestore: scheduler.cancel
  })

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  harness.toolbar.bounds.x += 19
  harness.toolbar.failOn.add('setBounds')
  scheduler.advance(POST_RESTORE_QUIET_MS)

  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
  assert.equal(scheduler.pendingCount(), 0)
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'post-restore-bounds-failed' }
  ])
  assert.doesNotMatch(JSON.stringify(harness.faults), /private-path/)
})

test('SEM-F22/SEM-F24/T04/J17/J19: restoreOrShow failure keeps the primary reachable and closes the interaction generation', () => {
  const harness = createHarness()
  harness.toolbar.minimized = true
  harness.toolbar.visible = false
  harness.toolbar.failOn.add('focus')

  assert.equal(harness.controller.restoreOrShow(), false)
  assert.equal(harness.toolbar.minimized, false)
  assert.equal(harness.toolbar.visible, true)
  assert.deepEqual(harness.getDegradedGenerations(), [2])
  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.faults, [
    { role: 'application', code: 'show-failed' },
    { role: 'application', code: 'primary-restore-failed' }
  ])
})

test('SEM-F24/J19: overlay roles expose one stable Windows taskbar primary', () => {
  assert.deepEqual(overlayApplicationOptions('toolbar'), {
    title: PRIMARY_WINDOW_TITLE,
    minimizable: true,
    skipTaskbar: false
  })
  assert.deepEqual(overlayApplicationOptions('caption'), {
    title: PRIMARY_WINDOW_TITLE,
    minimizable: false,
    skipTaskbar: true
  })
  assert.equal(WINDOWS_APP_USER_MODEL_ID, 'com.live-subtitle.desktop')
  assert.throws(() => overlayApplicationOptions('settings'), /role is invalid/)
})

test('SEM-F24/J19: main routes primary close, renderer minimize and second instance restore through app lifecycle', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8')
  assert.match(source, /toolbarWin\.on\('close', \(event\) => \{[\s\S]{0,160}event\.preventDefault\(\)[\s\S]{0,80}app\.quit\(\)/)
  assert.match(source, /action === 'minimize'\) applicationWindowLifecycleController\.minimize\(\)/)
  assert.match(source, /app\.on\('second-instance',[\s\S]{0,100}applicationWindowLifecycleController\.restoreOrShow\(\)/)
  assert.match(source, /app\.setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\)/)
  assert.match(source, /did-start-navigation[\s\S]{0,240}stopForSender\(senderId\)[\s\S]{0,160}suspendRoleForReload\(role\)/)
  assert.match(source, /render-process-gone[\s\S]{0,180}stopForSender\(senderId\)[\s\S]{0,180}failClosedAfterRendererGone\(role\)/)
  assert.match(source, /did-finish-load[\s\S]{0,140}stopForSender\(senderId\)[\s\S]{0,260}replay\(role\)/)
  assert.match(source, /const replayEpoch = navigationEpoch[\s\S]{0,260}replayEpoch === navigationEpoch/)
  assert.match(source, /if \(captionPassThroughPrepared\) captionWin\.show\(\)/)
})
