'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  ApplicationWindowLifecycleController,
  PRIMARY_WINDOW_TITLE,
  WINDOWS_APP_USER_MODEL_ID,
  overlayApplicationOptions
} = require('../../src/main/application-window-lifecycle-controller')

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
    this.bounds = { ...bounds }
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

function createHarness ({ settingsFocused = true, schedulePostRestore = setImmediate } = {}) {
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
  const degradedGenerations = []
  const controller = new ApplicationWindowLifecycleController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getSettingsWindow: () => settings,
    getHistoryWindow: () => history,
    stopInteractions: () => { stopCount += 1 },
    beginInteractionTransaction: () => { interactionGeneration += 1; return interactionGeneration },
    resumeInteractions: (generation) => { resumedGenerations.push(generation); return true },
    degradeInteractions: (generation) => { degradedGenerations.push(generation); return true },
    restoreWindowStack: () => { stackCount += 1 },
    schedulePostRestore,
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
  const scheduled = []
  const harness = createHarness({ schedulePostRestore: (callback) => scheduled.push(callback) })
  const original = harness.toolbar.getBounds()

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  assert.equal(scheduled.length, 1)

  harness.toolbar.bounds = { ...original, x: original.x + 31 }
  assert.equal(harness.controller.restoreOrShow(), true)
  assert.equal(scheduled.length, 2)

  scheduled[0]()
  assert.deepEqual(harness.toolbar.getBounds(), { ...original, x: original.x + 31 })
  assert.deepEqual(harness.getResumedGenerations(), [])

  scheduled[1]()
  assert.deepEqual(harness.getResumedGenerations(), [4])
})

test('SEM-F22/SEM-F24/T04/J17/J19: post-restore bounds failure degrades instead of resuming hit testing', () => {
  const scheduled = []
  const harness = createHarness({ schedulePostRestore: (callback) => scheduled.push(callback) })

  assert.equal(harness.controller.minimize(), true)
  assert.equal(harness.controller.restore(), true)
  harness.toolbar.bounds.x += 19
  harness.toolbar.failOn.add('setBounds')
  scheduled.shift()()

  assert.deepEqual(harness.getResumedGenerations(), [])
  assert.deepEqual(harness.getDegradedGenerations(), [3])
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
