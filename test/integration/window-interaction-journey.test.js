'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  ToolbarLayoutState,
  projectToolbarReport,
  toolbarDockBoundsFor
} = require('../../src/main/window-layout-contract')
const { createCaptionRendererDriver } = require('./caption-renderer-driver')
const {
  ManualWindowInteractionController
} = require('../../src/main/manual-window-interaction-controller')
const { WindowLayerController } = require('../../src/main/window-layer-controller')
const {
  ApplicationWindowLifecycleController
} = require('../../src/main/application-window-lifecycle-controller')
const {
  WindowInteractionGenerationController
} = require('../../src/main/window-interaction-generation-controller')

class FakeWindow extends EventEmitter {
  constructor (role, bounds) {
    super()
    this.role = role
    this.bounds = { ...bounds }
    this.destroyed = false
    this.alwaysOnTop = false
    this.moves = 0
    this.setBoundsCalls = 0
    this.setPositionCalls = 0
    this.webContents = new EventEmitter()
    this.visible = true
    this.minimized = false
    this.focused = false
    this.ignoreCalls = []
  }

  getBounds () { return { ...this.bounds } }
  isDestroyed () { return this.destroyed }
  isVisible () { return this.visible }
  isMinimized () { return this.minimized }
  isFocused () { return this.focused }
  hide () { this.visible = false; this.focused = false }
  show () { this.visible = true }
  showInactive () { this.visible = true }
  minimize () { this.minimized = true; this.visible = false; this.focused = false; this.emit('minimize') }
  restore () { this.minimized = false; this.visible = true; this.emit('restore') }
  focus () { this.focused = true }
  setIgnoreMouseEvents (ignore, options) { this.ignoreCalls.push([ignore, options]) }
  moveTop () { this.moves += 1 }
  setAlwaysOnTop (on) { this.alwaysOnTop = on }
  setBounds (bounds) {
    this.bounds = { ...bounds }
    this.setBoundsCalls += 1
  }

  /* 拖动只移动位置，不走 resize 路径 */
  setPosition (x, y) {
    this.bounds = { ...this.bounds, x, y }
    this.setPositionCalls += 1
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
    runAll () {
      for (const [id, callback] of [...callbacks]) {
        callbacks.delete(id)
        callback()
      }
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
  const geometrySettlements = []
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
    getToolbarWindow: () => toolbar,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    onCaptionResizeEnd: () => { resizePersistCount += 1 },
    onGeometrySettled: (roles) => geometrySettlements.push([...roles]),
    setTimer: scheduler.setTimer
  })

  const captionStart = caption.getBounds()
  assert.equal(interaction.startDrag({ role: 'caption', win: caption, senderId: 1 }), true)
  assert.equal(caption.setBoundsCalls + caption.setPositionCalls, 0,
    'press without a cursor delta must not move the window')
  interaction.stopDrag(1)
  assert.deepEqual(caption.getBounds(), captionStart)
  assert.deepEqual(geometrySettlements, [], 'stationary press/release has no geometry to re-hit')

  /* 拖动每帧只平移两个窗口，不再重新求解停靠位置。结果必须与逐帧 dock()
     逐像素相同 —— 省掉的是每帧两次 getBounds 和一次求解，不是精度。 */
  cursor = { x: 300, y: 200 }
  const beforeContinuousDrag = caption.getBounds()
  assert.equal(interaction.startDrag({ role: 'caption', win: caption, senderId: 1 }), true)
  const dockCallsBeforeDrag = dockOptions.length
  cursor = { x: 314, y: 209 }
  scheduler.runNext()
  assert.equal(dockOptions.length, dockCallsBeforeDrag, 'drag ticks must not re-solve the dock position')
  assert.equal(caption.setBoundsCalls, 0, 'drag must not take the resize path')
  assert.deepEqual(caption.getBounds(), {
    ...beforeContinuousDrag,
    x: beforeContinuousDrag.x + 14,
    y: beforeContinuousDrag.y + 9
  })
  assert.deepEqual(toolbar.getBounds(), toolbarDockBoundsFor(caption.getBounds()),
    'the companion lands exactly where dock() would have put it')
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
  assert.deepEqual(geometrySettlements.at(-1), ['caption', 'toolbar'])

  cursor = { x: 500, y: 300 }
  const beforeUnlockedGrip = caption.getBounds()
  assert.equal(interaction.startDrag({ role: 'toolbar', win: toolbar, senderId: 2 }), true)
  cursor = { x: 507, y: 305 }
  scheduler.runNext()
  assert.equal(caption.getBounds().x, beforeUnlockedGrip.x + 7)
  interaction.stopDrag(2)
  assert.deepEqual(geometrySettlements.at(-1), ['caption', 'toolbar'])

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
  assert.deepEqual(geometrySettlements.at(-1), ['toolbar'])

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

test('SEM-F22/SEM-F24/J17/J19: real caption hit intents stay stable near the toolbar before and after restore', () => {
  const caption = new FakeWindow('caption', { x: 100, y: 80, width: 920, height: 190 })
  const toolbar = new FakeWindow('toolbar', toolbarDockBoundsFor(caption.getBounds()))
  const settings = new FakeWindow('settings', { x: 180, y: 120, width: 880, height: 620 })
  const history = new FakeWindow('history', { x: 220, y: 140, width: 1060, height: 720 })
  const windows = { caption, toolbar, settings, history }
  const manualTimers = controlledScheduler()
  const generationTimers = controlledScheduler()
  const postRestore = []
  const syncs = []
  let cursor = { x: 800, y: 115 }
  let locked = false
  let dragIntentCount = 0
  let resizeIntentCount = 0
  let toolbarContourYieldCount = 0
  let generation
  let renderer

  const manual = new ManualWindowInteractionController({
    clearTimer: manualTimers.clearTimer,
    dock: () => toolbar.setBounds(toolbarDockBoundsFor(caption.getBounds())),
    getCaptionLimits: () => ({ minW: 480, maxW: 1600, minH: 140, maxH: 420 }),
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    onCaptionResizeEnd: () => {},
    onGeometrySettled: (roles) => generation.refreshPointerHits(roles),
    setTimer: manualTimers.setTimer
  })
  generation = new WindowInteractionGenerationController({
    clearTimer: generationTimers.clearTimer,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    getWindow: (role) => windows[role],
    sendSync: (win, payload) => {
      syncs.push([win.role, payload])
      if (win.role === 'caption') renderer?.sync(payload)
      else if (win.role === 'toolbar' && payload.phase === 'resume') {
        generation.acceptMouseThrough('toolbar', {
          schemaVersion: 1, generation: payload.generation, ignore: true
        })
      }
      return true
    },
    setTimer: generationTimers.setTimer
  })

  const overlap = projectToolbarReport({
    generation: 1,
    rect: { x: 184, y: 16, width: 400, height: 40 }
  }, 1)
  assert.ok(overlap)
  const cardRect = { x: 20, y: 20, left: 20, top: 20, right: 900, bottom: 170, width: 880, height: 150 }
  const toolbarHoleRect = {
    left: cardRect.right - overlap.rect.right - overlap.rect.width,
    top: cardRect.top + overlap.rect.top,
    right: cardRect.right - overlap.rect.right,
    bottom: cardRect.top + overlap.rect.top + overlap.rect.height
  }
  renderer = createCaptionRendererDriver({
    cardRect,
    toolbarHoleRect,
    mouseThrough: (ignore) => generation.acceptMouseThrough('caption', {
      schemaVersion: 1, generation: generation.getState().generation, ignore
    }),
    dragStart: () => {
      const current = generation.getState().generation
      if (!generation.acceptGesture('caption', { schemaVersion: 1, generation: current })) return false
      dragIntentCount += 1
      return manual.startDrag({ role: 'caption', win: caption, senderId: 1 })
    },
    dragEnd: () => manual.stopDrag(1),
    resizeStart: (edge) => {
      const current = generation.getState().generation
      if (!generation.acceptResizeStart('caption', { schemaVersion: 1, generation: current, edge })) return false
      resizeIntentCount += 1
      return manual.startResize({ win: caption, senderId: 1, edge })
    },
    resizeEnd: () => manual.stopResize(1)
  })
  generation.replay('caption')
  generation.replay('toolbar')

  const toolbarAdjacentPoints = [
    { x: Math.round((toolbarHoleRect.left + toolbarHoleRect.right) / 2), y: toolbarHoleRect.top - 5 },
    { x: toolbarHoleRect.right + 5, y: Math.round((toolbarHoleRect.top + toolbarHoleRect.bottom) / 2) }
  ]
  const toolbarContourPoints = [
    { x: Math.round((toolbarHoleRect.left + toolbarHoleRect.right) / 2), y: toolbarHoleRect.top + 1 },
    { x: toolbarHoleRect.right - 1, y: Math.round((toolbarHoleRect.top + toolbarHoleRect.bottom) / 2) }
  ]
  const exerciseDrag = (point, delta, label, { moveBeforeDown = true } = {}) => {
    const before = caption.getBounds()
    cursor = { x: before.x + point.x, y: before.y + point.y }
    if (moveBeforeDown) renderer.move(point.x, point.y)
    renderer.pointerDown(point.x, point.y)
    cursor = { x: cursor.x + delta.x, y: cursor.y + delta.y }
    manualTimers.runNext()
    renderer.pointerUp()
    const after = caption.getBounds()
    assert.equal(after.width, before.width, `${label}: width must not drift`)
    assert.equal(after.height, before.height, `${label}: height must not drift`)
    assert.deepEqual(toolbar.getBounds(), toolbarDockBoundsFor(after), `${label}: toolbar must stay docked`)
  }
  const exerciseToolbarContourPress = (point, jitter, label) => {
    const before = caption.getBounds()
    const dragCountBefore = dragIntentCount
    const resizeCountBefore = resizeIntentCount
    cursor = { x: before.x + point.x, y: before.y + point.y }
    renderer.move(point.x, point.y)
    assert.equal(caption.ignoreCalls.at(-1)[0], true, `${label}: caption must yield the real toolbar contour`)
    renderer.pointerDown(point.x, point.y)
    cursor = { x: cursor.x + jitter.x, y: cursor.y + jitter.y }
    renderer.move(point.x + jitter.x, point.y + jitter.y)
    renderer.pointerUp()
    assert.equal(manualTimers.size(), 0, `${label}: toolbar-owned press must not start a caption gesture`)
    assert.equal(dragIntentCount, dragCountBefore, `${label}: toolbar contour must not emit caption drag`)
    assert.equal(resizeIntentCount, resizeCountBefore, `${label}: toolbar contour must not emit caption resize`)
    assert.deepEqual(caption.getBounds(), before, `${label}: caption geometry must remain stable`)
    assert.deepEqual(toolbar.getBounds(), toolbarDockBoundsFor(before), `${label}: toolbar must stay docked`)
    toolbarContourYieldCount += 1
  }

  for (let round = 0; round < 20; round += 1) {
    exerciseToolbarContourPress(toolbarContourPoints[0], { x: 1, y: 1 }, `toolbar top contour round ${round}`)
    exerciseToolbarContourPress(toolbarContourPoints[1], { x: -1, y: 1 }, `toolbar right contour round ${round}`)
    exerciseDrag(toolbarAdjacentPoints[0], { x: 0, y: 1 }, `toolbar top-adjacent drag round ${round}`)
    exerciseDrag(toolbarAdjacentPoints[1], { x: 1, y: 0 }, `toolbar right-adjacent drag round ${round}`)
  }
  assert.equal(toolbarContourYieldCount, 40)
  assert.equal(dragIntentCount, 40)
  assert.equal(resizeIntentCount, 0, 'toolbar contour and adjacent presses must never become resize intents')

  const lifecycle = new ApplicationWindowLifecycleController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getSettingsWindow: () => settings,
    getHistoryWindow: () => history,
    stopInteractions: () => manual.stopAll(),
    beginInteractionTransaction: () => generation.beginTransaction(),
    resumeInteractions: (value) => generation.resume(value),
    degradeInteractions: (value) => generation.degradeForRestoreFailure(value),
    restoreWindowStack: () => {},
    schedulePostRestore: (callback) => postRestore.push(callback)
  })
  lifecycle.bindPrimaryWindow(toolbar)
  assert.equal(lifecycle.minimize(), true)
  assert.equal(lifecycle.restore(), true)
  const restoredBounds = caption.getBounds()
  const restoredPoint = toolbarAdjacentPoints[1]
  cursor = { x: restoredBounds.x + restoredPoint.x, y: restoredBounds.y + restoredPoint.y }
  postRestore.shift()()
  const restoredGeneration = generation.getState().generation
  assert.equal(syncs.some(([role, payload]) => role === 'caption' &&
    payload.generation === restoredGeneration && payload.phase === 'resume'), true)
  assert.equal(caption.ignoreCalls.at(-1)[0], false,
    'the stationary post-restore pointer must synchronously restore the ordinary drag hit')

  exerciseDrag(restoredPoint, { x: 1, y: 0 }, 'first toolbar-adjacent drag after restore', {
    moveBeforeDown: false
  })
  assert.equal(dragIntentCount, 41)
  assert.equal(resizeIntentCount, 0)
  assert.equal(caption.ignoreCalls.at(-1)[0], false)
})

test('SEM-F22/SEM-F24/SEM-T04/J17/J19: lifecycle, generation and manual bounds form one restore journey', () => {
  const caption = new FakeWindow('caption', { x: 100, y: 80, width: 920, height: 190 })
  const toolbar = new FakeWindow('toolbar', { x: 420, y: 92, width: 600, height: 72 })
  const settings = new FakeWindow('settings', { x: 180, y: 120, width: 880, height: 620 })
  const history = new FakeWindow('history', { x: 220, y: 140, width: 1060, height: 720 })
  const windows = { caption, toolbar, settings, history }
  const senderIds = { caption: 1, toolbar: 2, settings: 3, history: 4 }
  const manualTimers = controlledScheduler()
  const generationTimers = controlledScheduler()
  const postRestore = []
  const syncs = []
  const faults = []
  const ackRoles = new Set(['caption', 'toolbar'])
  let cursor = { x: 300, y: 180 }
  let locked = false

  const manual = new ManualWindowInteractionController({
    clearTimer: manualTimers.clearTimer,
    dock: () => toolbar.setBounds(toolbarDockBoundsFor(caption.getBounds(), toolbar.getBounds())),
    getCaptionLimits: () => ({ minW: 480, maxW: 1600, minH: 140, maxH: 420 }),
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    onCaptionResizeEnd: () => {},
    onGeometrySettled: (roles) => generation.refreshPointerHits(roles),
    setTimer: manualTimers.setTimer
  })

  let generation
  generation = new WindowInteractionGenerationController({
    clearTimer: generationTimers.clearTimer,
    getCursorScreenPoint: () => ({ ...cursor }),
    getLocked: () => locked,
    getWindow: (role) => windows[role],
    onFault: (fault) => faults.push(fault),
    sendSync: (win, payload) => {
      syncs.push([win.role, payload])
      if (payload.phase === 'resume' && ackRoles.has(win.role)) {
        generation.acceptMouseThrough(win.role, {
          schemaVersion: 1,
          generation: payload.generation,
          ignore: win.role === 'toolbar'
        })
      }
      return true
    },
    setTimer: generationTimers.setTimer
  })

  const lifecycle = new ApplicationWindowLifecycleController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    getSettingsWindow: () => settings,
    getHistoryWindow: () => history,
    stopInteractions: () => manual.stopAll(),
    beginInteractionTransaction: () => generation.beginTransaction(),
    resumeInteractions: (value) => generation.resume(value),
    degradeInteractions: (value) => generation.degradeForRestoreFailure(value),
    restoreWindowStack: () => {},
    schedulePostRestore: (callback) => postRestore.push(callback),
    onFault: (fault) => faults.push(fault)
  })
  lifecycle.bindPrimaryWindow(toolbar)
  lifecycle.bindAuxiliaryWindow(settings, 'settings')
  lifecycle.bindAuxiliaryWindow(history, 'history')

  const initialBounds = caption.getBounds()
  assert.equal(manual.startDrag({ role: 'caption', win: caption, senderId: senderIds.caption }), true)
  assert.equal(manualTimers.size(), 1)
  assert.equal(lifecycle.minimize(), true)
  assert.equal(generation.getState().generation, 2)
  assert.equal(manualTimers.size(), 0, 'minimize must stop the old manual drag without renderer terminal events')
  cursor = { x: 345, y: 211 }
  assert.deepEqual(caption.getBounds(), initialBounds)

  assert.equal(lifecycle.restore(), true)
  assert.equal(generation.getState().generation, 3)
  postRestore.shift()()
  assert.deepEqual(generation.getState(), { generation: 3, phase: 'resume' })
  for (const role of Object.keys(windows)) {
    assert.equal(syncs.some(([candidate, payload]) => candidate === role &&
      payload.generation === 3 && payload.phase === 'suspend'), true)
    assert.equal(syncs.some(([candidate, payload]) => candidate === role &&
      payload.generation === 3 && payload.phase === 'resume'), true)
  }
  assert.equal(caption.ignoreCalls.at(-1)[0], false,
    'the stationary local pointer is re-evaluated by the current renderer generation')
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 2 }), false)
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 3 }), true)

  assert.equal(manual.startDrag({ role: 'caption', win: caption, senderId: senderIds.caption }), true)
  cursor = { x: 358, y: 220 }
  manualTimers.runNext()
  assert.notDeepEqual(caption.getBounds(), initialBounds,
    'the first new press after restore produces a current-generation drag')
  const beforeDragSettlementSyncs = syncs.length
  manual.stopForSender(senderIds.caption)
  assert.deepEqual(syncs.slice(beforeDragSettlementSyncs).map(([role, payload]) => [role, payload.phase, payload.generation]), [
    ['caption', 'resume', 3], ['toolbar', 'resume', 3]
  ], 'combined caption drag settlement re-hits both changed overlay bounds')

  cursor = { x: 500, y: 260 }
  assert.equal(manual.startResize({ win: caption, senderId: senderIds.caption, edge: 'se' }), true)
  cursor = { x: 506, y: 264 }
  manualTimers.runNext()
  const beforeResizeSettlementSyncs = syncs.length
  manual.stopResize(senderIds.caption)
  assert.deepEqual(syncs.slice(beforeResizeSettlementSyncs).map(([role, payload]) => [role, payload.phase, payload.generation]), [
    ['caption', 'resume', 3], ['toolbar', 'resume', 3]
  ], 'caption resize settlement re-hits both changed overlay bounds')

  cursor = { x: 550, y: 280 }
  assert.equal(manual.startDrag({ role: 'toolbar', win: toolbar, senderId: senderIds.toolbar }), true)
  cursor = { x: 554, y: 283 }
  manualTimers.runNext()
  const beforeCombinedToolbarSettlementSyncs = syncs.length
  manual.stopDrag(senderIds.toolbar)
  assert.deepEqual(syncs.slice(beforeCombinedToolbarSettlementSyncs).map(([role, payload]) => [role, payload.phase, payload.generation]), [
    ['caption', 'resume', 3], ['toolbar', 'resume', 3]
  ], 'unlocked toolbar grip settlement re-hits the moved pair')

  locked = true
  cursor = { x: 600, y: 300 }
  assert.equal(manual.startDrag({ role: 'toolbar', win: toolbar, senderId: senderIds.toolbar }), true)
  cursor = { x: 605, y: 302 }
  manualTimers.runNext()
  const beforeLockedToolbarSettlementSyncs = syncs.length
  manual.stopDrag(senderIds.toolbar)
  assert.deepEqual(syncs.slice(beforeLockedToolbarSettlementSyncs).map(([role, payload]) => [role, payload.phase, payload.generation]), [
    ['toolbar', 'resume', 3]
  ], 'locked toolbar-only settlement re-hits only the changed toolbar bounds')
  locked = false

  generation.suspendRoleForReload('caption')
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 3 }), false)
  generation.replay('caption')
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 3 }), true)

  assert.equal(generation.failClosedAfterRendererGone('caption'), true)
  assert.equal(caption.ignoreCalls.at(-1)[0], true,
    'a crashed caption renderer cannot leave a solid native hit surface behind')
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 3 }), false)
  generation.replay('caption')
  assert.equal(generation.acceptGesture('caption', { schemaVersion: 1, generation: 3 }), true)

  assert.equal(lifecycle.minimize(), true)
  const generationBeforeMinimizedCrash = generation.getState().generation
  assert.equal(generation.failClosedAfterRendererGone('toolbar'), true)
  assert.equal(toolbar.isMinimized(), true,
    'a toolbar renderer crash while minimized preserves the application minimize')
  assert.equal(caption.isVisible(), false,
    'a toolbar renderer crash while minimized does not reveal the caption')
  assert.equal(generation.getState().generation, generationBeforeMinimizedCrash,
    'a renderer crash does not start a restore generation')
  assert.equal(lifecycle.restore(), true)
  postRestore.shift()()
  const generationAfterMinimizedCrashRestore = generation.getState().generation

  assert.equal(generation.failClosedAfterRendererGone('toolbar'), true)
  assert.equal(toolbar.ignoreCalls.at(-1)[0], false,
    'a crashed toolbar renderer keeps the taskbar primary solid and reachable')
  assert.equal(generation.acceptGesture('toolbar', {
    schemaVersion: 1,
    generation: generationAfterMinimizedCrashRestore
  }), false)
  generation.replay('toolbar')

  ackRoles.delete('toolbar')
  assert.equal(lifecycle.minimize(), true)
  assert.equal(lifecycle.restore(), true)
  postRestore.shift()()
  generationTimers.runAll()
  assert.deepEqual(faults.at(-1), { role: 'toolbar', code: 'interaction-sync-timeout' })
  assert.equal(toolbar.ignoreCalls.at(-1)[0], false)
  const current = generation.getState().generation
  assert.equal(generation.acceptMouseThrough('toolbar', {
    schemaVersion: 1, generation: current, ignore: true
  }), true, 'a late current acknowledgement closes the explicit solid fallback')

  locked = true
  assert.equal(generation.acceptMouseThrough('caption', {
    schemaVersion: 1, generation: current, ignore: false
  }), true)
  assert.equal(caption.ignoreCalls.at(-1)[0], true, 'locked caption remains pass-through')
  assert.equal(faults.some((fault) => fault.code === 'stale-interaction-generation'), true)
})
