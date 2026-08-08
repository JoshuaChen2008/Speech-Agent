'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  ToolbarLayoutState,
  toolbarDockBoundsFor
} = require('../../src/main/window-layout-contract')
const {
  ManualWindowInteractionController
} = require('../../src/main/manual-window-interaction-controller')
const { WindowLayerController } = require('../../src/main/window-layer-controller')

class FakeWindow extends EventEmitter {
  constructor (role, bounds) {
    super()
    this.role = role
    this.bounds = { ...bounds }
    this.destroyed = false
    this.alwaysOnTop = false
    this.moves = 0
    this.setBoundsCalls = 0
    this.webContents = new EventEmitter()
  }

  getBounds () { return { ...this.bounds } }
  isDestroyed () { return this.destroyed }
  moveTop () { this.moves += 1 }
  setAlwaysOnTop (on) { this.alwaysOnTop = on }
  setBounds (bounds) {
    this.bounds = { ...bounds }
    this.setBoundsCalls += 1
  }
}

function controlledScheduler () {
  let nextId = 0
  const callbacks = new Map()
  return {
    clearTimer: (id) => callbacks.delete(id),
    runNext () {
      const entry = callbacks.entries().next().value
      assert.ok(entry, 'an interaction tick must be scheduled')
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

test('SEM-F22/J17: one deterministic journey closes contour generations, manual bounds and foreground round-trips', () => {
  const layout = new ToolbarLayoutState()
  assert.equal(layout.getOverlap().source, 'fallback')
  assert.equal(layout.acceptReport({
    generation: 1,
    rect: { x: 500, y: 4, width: 80, height: 40 }
  }).source, 'toolbar')
  assert.equal(layout.acceptReport({
    generation: 1,
    rect: { x: 400, y: 4, width: 180, height: 40 }
  }).rect.width, 180)
  assert.equal(layout.acceptReport({
    generation: 1,
    rect: { x: -1, y: 0, width: 80, height: 40 }
  }).source, 'fallback')
  assert.equal(layout.invalidate().generation, 2)
  assert.equal(layout.acceptReport({
    generation: 1,
    rect: { x: 500, y: 4, width: 80, height: 40 }
  }).source, 'fallback')
  assert.equal(layout.acceptReport({
    generation: 2,
    rect: { x: 500, y: 4, width: 80, height: 40 }
  }).source, 'toolbar')

  const caption = new FakeWindow('caption', { x: 100, y: 80, width: 920, height: 190 })
  const toolbar = new FakeWindow('toolbar', { x: 0, y: 0, width: 600, height: 72 })
  const settings = new FakeWindow('settings', { x: 180, y: 120, width: 880, height: 620 })
  const history = new FakeWindow('history', { x: 220, y: 140, width: 1060, height: 720 })
  const scheduler = controlledScheduler()
  let cursor = { x: 300, y: 200 }
  let locked = false
  let resizePersistCount = 0
  const dockOptions = []
  const dock = (options) => {
    dockOptions.push(options || null)
    toolbar.setBounds(toolbarDockBoundsFor(caption.getBounds(), toolbar.getBounds()))
  }
  dock()

  const interaction = new ManualWindowInteractionController({
    clearTimer: scheduler.clearTimer,
    dock,
    getCaptionLimits: () => ({ minW: 480, maxW: 1600, minH: 140, maxH: 420 }),
    getCaptionWindow: () => caption,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    onCaptionResizeEnd: () => { resizePersistCount += 1 },
    setTimer: scheduler.setTimer
  })

  const captionStart = caption.getBounds()
  assert.equal(interaction.startDrag({ role: 'caption', win: caption, senderId: 1 }), true)
  assert.equal(caption.setBoundsCalls, 0, 'press without a cursor delta must not set bounds')
  interaction.stopDrag(1)
  assert.deepEqual(caption.getBounds(), captionStart)

  assert.equal(interaction.startDrag({ role: 'caption', win: caption, senderId: 1 }), true)
  cursor = { x: 314, y: 209 }
  scheduler.runNext()
  assert.deepEqual(dockOptions.at(-1), { restoreStack: false })
  assert.deepEqual(caption.getBounds(), { ...captionStart, x: captionStart.x + 14, y: captionStart.y + 9 })
  assert.deepEqual(toolbar.getBounds(), toolbarDockBoundsFor(caption.getBounds(), toolbar.getBounds()))
  interaction.stopDrag(1)

  cursor = { x: 420, y: 260 }
  const beforeResize = caption.getBounds()
  assert.equal(interaction.startResize({ win: caption, senderId: 1, edge: 'se' }), true)
  cursor = { x: 432, y: 268 }
  scheduler.runNext()
  assert.deepEqual(dockOptions.at(-1), { restoreStack: false })
  assert.equal(caption.getBounds().width, beforeResize.width + 12)
  assert.equal(caption.getBounds().height, beforeResize.height + 8)
  interaction.stopResize(1)
  assert.equal(resizePersistCount, 1)

  cursor = { x: 500, y: 300 }
  const beforeUnlockedGrip = caption.getBounds()
  assert.equal(interaction.startDrag({ role: 'toolbar', win: toolbar, senderId: 2 }), true)
  cursor = { x: 507, y: 305 }
  scheduler.runNext()
  assert.equal(caption.getBounds().x, beforeUnlockedGrip.x + 7)
  interaction.stopDrag(2)

  locked = true
  cursor = { x: 600, y: 320 }
  const lockedCaption = caption.getBounds()
  const lockedToolbar = toolbar.getBounds()
  assert.equal(interaction.startDrag({ role: 'caption', win: caption, senderId: 1 }), false)
  assert.equal(interaction.startResize({ win: caption, senderId: 1, edge: 'e' }), false)
  assert.equal(interaction.startDrag({ role: 'toolbar', win: toolbar, senderId: 2 }), true)
  cursor = { x: 611, y: 326 }
  scheduler.runNext()
  assert.deepEqual(caption.getBounds(), lockedCaption)
  assert.equal(toolbar.getBounds().x, lockedToolbar.x + 11)
  interaction.stopDrag(2)

  const layers = new WindowLayerController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar
  })
  layers.bindForegroundWindow(settings, 'settings')
  layers.bindForegroundWindow(history, 'history')
  settings.emit('focus')
  history.emit('focus')
  assert.equal(settings.alwaysOnTop, false)
  assert.equal(history.alwaysOnTop, true)
  layers.restoreWindowStack()
  assert.equal(layers.getActiveRole(), 'history')
  history.emit('blur')
  assert.equal(history.alwaysOnTop, false)

  locked = false
  cursor = { x: 700, y: 400 }
  assert.equal(interaction.startDrag({ role: 'settings', win: settings, senderId: 3 }), true)
  interaction.stopForSender(3)
  cursor = { x: 740, y: 440 }
  assert.equal(scheduler.size(), 0, 'blur cancellation must remove the pending drag tick')
})
