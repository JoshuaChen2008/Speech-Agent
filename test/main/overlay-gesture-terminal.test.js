'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { createOverlayGestureTerminal } = require('../../src/main/overlay-gesture-terminal')
const {
  WindowInteractionGenerationController
} = require('../../src/main/window-interaction-generation-controller')

function createHarness ({ activeSenderId = null } = {}) {
  const caption = new EventEmitter()
  caption.id = 11
  const toolbar = new EventEmitter()
  toolbar.id = 22
  let stops = 0
  let resets = 0
  let degradations = 0
  let senderId = activeSenderId
  const terminal = createOverlayGestureTerminal({
    getActiveSenderId: () => senderId,
    stopInteractions: () => { stops += 1; senderId = null },
    resetInteractionGeneration: () => { resets += 1; return true },
    degradeInteractions: () => { degradations += 1 }
  })
  assert.equal(terminal.bind({ role: 'caption', webContents: caption }), true)
  assert.equal(terminal.bind({ role: 'toolbar', webContents: toolbar }), true)
  return {
    caption,
    toolbar,
    counts: () => ({ stops, resets, degradations }),
    setActiveSenderId: (value) => { senderId = value },
    terminal
  }
}

test('SEM-F22/J17: same-overlay release stops the main gesture without a lifecycle reset', () => {
  const harness = createHarness({ activeSenderId: 11 })
  harness.caption.emit('before-mouse-event', {}, {
    type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown']
  })
  harness.caption.emit('before-mouse-event', {}, {
    type: 'mouseUp', button: 'left', modifiers: []
  })
  assert.deepEqual(harness.counts(), { stops: 1, resets: 0, degradations: 0 })
})

test('SEM-F22/SEM-T04/J17: cross-overlay release resets even a renderer-only pending resize', () => {
  const harness = createHarness()
  harness.caption.emit('before-mouse-event', {}, {
    type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown']
  })
  harness.toolbar.emit('before-mouse-event', {}, {
    type: 'mouseUp', button: 'left', modifiers: []
  })
  assert.deepEqual(harness.counts(), { stops: 1, resets: 1, degradations: 0 },
    'the main may be idle while caption still owns a pending resize')
})

test('SEM-F22/J17: an active sender identifies a cross-overlay synthetic terminal', () => {
  const harness = createHarness({ activeSenderId: 11 })
  harness.toolbar.emit('before-mouse-event', {}, {
    type: 'mouseUp', button: 'left', modifiers: []
  })
  assert.deepEqual(harness.counts(), { stops: 1, resets: 1, degradations: 0 })
})

test('SEM-F22/SEM-T04/J17: missing-primary movement closes the recorded overlay sequence', () => {
  const harness = createHarness({ activeSenderId: 11 })
  harness.caption.emit('before-mouse-event', {}, {
    type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown']
  })
  harness.toolbar.emit('before-mouse-event', {}, { type: 'mouseMove' })
  assert.deepEqual(harness.counts(), { stops: 0, resets: 0, degradations: 0 },
    'an omitted optional modifier list is not proof of release')
  harness.toolbar.emit('before-mouse-event', {}, { type: 'mouseMove', modifiers: [] })
  assert.deepEqual(harness.counts(), { stops: 1, resets: 1, degradations: 0 })
})

test('SEM-F22/SEM-T04/J17: a failed cross-overlay generation reset degrades the pair once', () => {
  const caption = new EventEmitter()
  caption.id = 11
  const toolbar = new EventEmitter()
  toolbar.id = 22
  let degradations = 0
  const terminal = createOverlayGestureTerminal({
    getActiveSenderId: () => null,
    stopInteractions () {},
    resetInteractionGeneration () { throw new Error('private-path') },
    degradeInteractions () { degradations += 1 }
  })
  terminal.bind({ role: 'caption', webContents: caption })
  terminal.bind({ role: 'toolbar', webContents: toolbar })
  caption.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
  toolbar.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' })
  assert.equal(degradations, 1)
})

test('SEM-F22/SEM-T04/J17: reset degradation leaves caption through and toolbar solid', () => {
  const captionContents = new EventEmitter()
  captionContents.id = 11
  const toolbarContents = new EventEmitter()
  toolbarContents.id = 22
  const makeWindow = (bounds) => ({
    bounds,
    hidden: false,
    ignore: null,
    minimized: false,
    getBounds () { return { ...this.bounds } },
    hide () { this.hidden = true },
    isDestroyed () { return false },
    isMinimized () { return this.minimized },
    restore () { this.minimized = false },
    setIgnoreMouseEvents (ignore) { this.ignore = ignore },
    show () { this.hidden = false }
  })
  const windows = {
    caption: makeWindow({ x: 100, y: 80, width: 920, height: 190 }),
    toolbar: makeWindow({ x: 396, y: 104, width: 600, height: 72 })
  }
  const generation = new WindowInteractionGenerationController({
    getCursorScreenPoint: () => ({ x: 450, y: 120 }),
    getLocked: () => false,
    getWindow: (role) => windows[role] || null,
    sendSync: () => true
  })
  const terminal = createOverlayGestureTerminal({
    getActiveSenderId: () => null,
    stopInteractions () {},
    resetInteractionGeneration () { return false },
    degradeInteractions () {
      generation.degradeForRestoreFailure(generation.getState().generation)
    }
  })
  terminal.bind({ role: 'caption', webContents: captionContents })
  terminal.bind({ role: 'toolbar', webContents: toolbarContents })
  captionContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
  toolbarContents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' })

  assert.deepEqual(generation.getState(), { generation: 1, phase: 'suspend' })
  assert.equal(windows.caption.ignore, true)
  assert.equal(windows.caption.hidden, true)
  assert.equal(windows.toolbar.ignore, false)
  assert.equal(windows.toolbar.hidden, false)
})

test('SEM-F22/J17: non-overlay roles do not install native input observers', () => {
  const webContents = new EventEmitter()
  webContents.id = 33
  const terminal = createOverlayGestureTerminal({
    getActiveSenderId: () => null,
    stopInteractions () {},
    resetInteractionGeneration () { return true },
    degradeInteractions () {}
  })
  assert.equal(terminal.bind({ role: 'settings', webContents }), false)
  assert.equal(webContents.listenerCount('before-mouse-event'), 0)
})
