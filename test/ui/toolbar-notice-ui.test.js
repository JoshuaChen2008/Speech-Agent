'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { transpileRenderer } = require('./transpile-renderer')

const root = path.resolve(__dirname, '..', '..')

class FakeClassList {
  constructor (owner) { this.owner = owner; this.values = new Set() }
  add (...values) { values.forEach((value) => this.values.add(value)) }
  remove (...values) { values.forEach((value) => this.values.delete(value)) }
  toggle (value, force) {
    if (force === true) this.values.add(value)
    else if (force === false) this.values.delete(value)
    else if (this.values.has(value)) this.values.delete(value)
    else this.values.add(value)
  }
  contains (value) { return this.values.has(value) }
}

class FakeElement {
  constructor (tagName = 'div') {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.classList = new FakeClassList(this)
    this.disabled = false
    this.style = {}
    this.title = ''
    this._textContent = ''
    this._innerHTML = ''
    this.rect = null
  }
  set className (value) {
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean))
  }
  get className () { return [...this.classList.values].join(' ') }
  set textContent (value) {
    this._textContent = String(value)
    if (value === '') this.children = []
  }
  get textContent () { return this._textContent }
  set innerHTML (value) {
    this._innerHTML = String(value)
    this.children = [new FakeElement('svg')]
  }
  get innerHTML () { return this._innerHTML }
  get firstChild () { return this.children[0] || null }
  appendChild (child) { this.children.push(child); child.parent = this; return child }
  setAttribute (name, value) { this.attributes.set(name, String(value)) }
  getAttribute (name) { return this.attributes.get(name) ?? null }
  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }
  closest (selector) {
    if (selector === '.act' && this.classList.contains('act')) return this
    if (selector === '.toolbar' && this.classList.contains('toolbar')) return this
    return this.parent?.closest(selector) || null
  }
  querySelector (selector) {
    if (selector.startsWith('.')) {
      const className = selector.slice(1)
      const queue = [...this.children]
      while (queue.length > 0) {
        const node = queue.shift()
        if (node.classList.contains(className)) return node
        queue.push(...node.children)
      }
    }
    return null
  }
  setPointerCapture () {}
  getBoundingClientRect () {
    return this.rect || { x: 184, y: 16, width: 400, height: 40, left: 184, top: 16, right: 584, bottom: 56 }
  }
}

async function flush () {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createHarness ({ deferFrames = false, toolbarRect = null } = {}) {
  const ids = ['wrap', 'toolbar', 'grip', 'status', 'commands', 'windowControls']
  const elements = new Map(ids.map((id) => [id, new FakeElement('div')]))
  elements.get('toolbar').classList.add('toolbar')
  if (toolbarRect) elements.get('toolbar').rect = toolbarRect
  const callbacks = {}
  const actions = []
  const layoutReports = []
  const observedLayoutTargets = []
  const throughCalls = []
  let dragController = null
  let triggerToolbarResize = () => {}
  let triggerToolbarMutation = () => {}
  const frames = []
  const shell = {
    mouseThrough: (ignore) => throughCalls.push(ignore),
    dragStart () {}, dragEnd () {}, lockToggle () {},
    action: (name) => actions.push(name),
    onInteractionSync: (callback) => { callbacks.interaction = callback },
    onLock: (callback) => { callbacks.lock = callback },
    onConfig: (callback) => { callbacks.config = callback },
    onSnapshot: (callback) => { callbacks.snapshot = callback },
    onRefinementNotice: (callback) => { callbacks.notice = callback },
    getToolbarLayoutContext: async () => ({ generation: 7 }),
    reportToolbarLayout: (report) => layoutReports.push(structuredClone(report)),
    getLock: async () => false,
    getConfig: async () => ({}),
    getSnapshot: async () => ({ revision: 1 }),
    getRefinementNotice: async () => null,
    command: async () => ({ ok: true })
  }
  const documentListeners = new Map()
  const document = {
    documentElement: new FakeElement('html'),
    getElementById: (id) => elements.get(id),
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener (name, callback) {
      if (!documentListeners.has(name)) documentListeners.set(name, [])
      documentListeners.get(name).push(callback)
    },
    dispatch (name, event = {}) {
      for (const callback of documentListeners.get(name) || []) callback(event)
    },
    elementFromPoint: () => elements.get('toolbar')
  }
  const window = {
    shell,
    Icons: {
      installSprite () {},
      iconMarkup: (name) => `<svg data-icon="${name}"></svg>`
    },
    RuntimeView: {
      buildRuntimeView: () => ({
        status: { tone: 'idle', emphasis: 'quiet', ariaLabel: '空闲', icon: 'idle', message: '' },
        primary: {
          act: 'start', icon: 'start', label: '开始', showLabel: false,
          ariaLabel: '开始', disabled: false, reason: null
        },
        secondary: [],
        nextAction: null
      })
    },
    Appearance: { applyAppearance () {} },
    FIXTURES: { runtime: { unavailable: { revision: 0 } } },
    ManualWindowDrag: {
      bindManualWindowDrag (options) {
        let activePointerId = null
        dragController = {
          cancel () {
            if (activePointerId === null) return
            activePointerId = null
            options.onActiveChange?.(false)
          },
          end (event) {
            if (activePointerId === null) return
            if (Number.isInteger(event?.pointerId) && event.pointerId !== activePointerId) return
            activePointerId = null
            options.onEnd?.(event)
            options.onActiveChange?.(false, event)
          },
          isDragging: () => activePointerId !== null,
          start (event = { pointerId: 7 }) {
            if (options.onStart?.(event) === false) return false
            activePointerId = event.pointerId
            options.onActiveChange?.(true, event)
            return true
          }
        }
        return dragController
      }
    },
    addEventListener () {}
  }
  vm.runInNewContext(transpileRenderer(path.join(root, 'src', 'toolbar', 'toolbar.ts')), {
    console,
    document,
    requestAnimationFrame: (callback) => {
      if (!deferFrames) return callback()
      frames.push(callback)
      return frames.length
    },
    ResizeObserver: class {
      constructor (callback) { this.callback = callback; triggerToolbarResize = callback }
      observe (target) { observedLayoutTargets.push(target) }
      disconnect () {}
    },
    MutationObserver: class {
      constructor (callback) { this.callback = callback; triggerToolbarMutation = callback }
      observe (target) { observedLayoutTargets.push(target) }
      disconnect () {}
    },
    window
  })
  return {
    actions,
    callbacks,
    document,
    dragController,
    elements,
    layoutReports,
    observedLayoutTargets,
    runFrames: () => { while (frames.length > 0) frames.shift()() },
    triggerToolbarMutation,
    triggerToolbarResize,
    throughCalls
  }
}

test('toolbar renderer shows and dismisses a post-session status without creating another row', async () => {
  const { actions, callbacks, elements } = createHarness()
  await flush()
  const status = elements.get('status')
  const toolbar = elements.get('toolbar')

  callbacks.notice({
    schemaVersion: 1,
    kind: 'refinement-fault',
    sessionId: 'session-1',
    message: '精修异常，已精修 6/10 段，其余保留原字幕'
  })

  assert.equal(status.classList.contains('refinement-notice'), true)
  assert.match(status.getAttribute('aria-label'), /可查看历史或关闭提示/)
  assert.equal(status.querySelector('.status-message').textContent, '精修异常，已精修 6/10 段，其余保留原字幕')
  const history = status.children.find((child) => child.dataset.act === 'history')
  const dismiss = status.children.find((child) => child.dataset.act === 'dismiss-refinement-notice')
  assert.ok(history)
  assert.ok(dismiss)

  for (const callback of toolbar.listeners.get('click')) callback({ target: history })
  for (const callback of toolbar.listeners.get('click')) callback({ target: dismiss })
  assert.deepEqual(actions, ['history', 'dismiss-refinement-notice'])

  callbacks.notice(null)
  assert.equal(status.classList.contains('refinement-notice'), false)
})

test('SEM-F22/J17: toolbar reports its existing contour with the main-issued generation', async () => {
  const { elements, layoutReports, observedLayoutTargets } = createHarness()
  await flush()

  assert.equal(observedLayoutTargets.length, 2)
  assert.equal(observedLayoutTargets.every((target) => target === elements.get('toolbar')), true,
    'resize and DOM mutation observers share the exact toolbar contour target')
  assert.deepEqual(layoutReports, [{
    generation: 7,
    rect: { x: 184, y: 16, width: 400, height: 40 }
  }])
})

/* 穿透状态一翻转，光标就换主人：穿透时由下面那个应用画，实心时才是本窗的箭头。
   所以判定每抖一次用户就看见光标闪一次。进入必须精确（否则条外一圈会白白吃掉
   下面应用的点击），离开必须粘住（否则边缘 1px 抖动就来回翻）。
   条的轮廓在本 harness 里是 184..584 × 16..56。 */
test('SEM-F22/J17: toolbar mouse-through enters and leaves on the same exact contour', async () => {
  const { callbacks, document, throughCalls } = createHarness()
  await flush()

  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 0, y: 0 }
  })
  assert.deepEqual(throughCalls, [true], '首帧未指到条，一律放行')

  throughCalls.length = 0
  document.dispatch('mousemove', { clientX: 300, clientY: 30 })
  assert.deepEqual(throughCalls, [false], '压在条上立刻变实心')

  throughCalls.length = 0
  document.dispatch('mousemove', { clientX: 588, clientY: 30 })
  assert.deepEqual(throughCalls, [true], '离开真实轮廓立即恢复穿透，不保留隐形命中带')

  throughCalls.length = 0
  document.dispatch('mousemove', { clientX: 588, clientY: 30 })
  assert.deepEqual(throughCalls, [], '真实轮廓之外保持穿透')

  document.dispatch('mousemove', { clientX: 580, clientY: 30 })
  assert.deepEqual(throughCalls, [false], '回到真实轮廓内才变实心')

  throughCalls.length = 0
  document.dispatch('mouseleave', {})
  assert.deepEqual(throughCalls, [true], '指针离开整个窗口时不能卡在实心态')
})

test('SEM-F22/SEM-T04/J17: the next toolbar press closes stale grip state before handling a button', async () => {
  const { actions, dragController, elements, throughCalls } = createHarness()
  await flush()
  const toolbar = elements.get('toolbar')
  const settings = new FakeElement('button')
  settings.classList.add('act')
  settings.dataset.act = 'settings'
  settings.parent = toolbar

  assert.equal(dragController.start(), true)
  assert.equal(dragController.isDragging(), true)
  const recoveryHandlers = toolbar.listeners.get('pointerdown') || []
  assert.ok(recoveryHandlers.length > 0, 'toolbar must own a primary-press recovery handler')
  for (const callback of recoveryHandlers) callback({
    button: 0,
    isPrimary: true,
    pointerId: 7,
    clientX: 240,
    clientY: 32,
    target: settings
  })
  for (const callback of toolbar.listeners.get('click') || []) callback({ target: settings })

  assert.equal(dragController.isDragging(), false)
  assert.equal(throughCalls.at(-1), false, 'the current button press keeps the toolbar solid')
  assert.deepEqual(actions, ['settings'])
})

test('SEM-F22/J17: a different primary pointer cannot cancel an active toolbar grip', async () => {
  const { dragController, elements, throughCalls } = createHarness()
  await flush()
  const toolbar = elements.get('toolbar')

  assert.equal(dragController.start({ pointerId: 91 }), true)
  const recoveryHandlers = toolbar.listeners.get('pointerdown') || []
  for (const callback of recoveryHandlers) callback({
    button: 0,
    isPrimary: true,
    pointerId: 92,
    clientX: 240,
    clientY: 32,
    target: toolbar
  })

  assert.equal(dragController.isDragging(), true)
  assert.deepEqual(throughCalls, [], 'different primary pointers retain independent gesture ownership')
})

test('SEM-F22/J17: toolbar local hit uses the same outward-rounded contour as the main projection', async () => {
  const { callbacks, document, throughCalls } = createHarness({
    toolbarRect: {
      x: 184.25, y: 16.25, left: 184.25, top: 16.25,
      right: 583.35, bottom: 55.35, width: 399.1, height: 39.1
    }
  })
  await flush()
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 0, y: 0 }
  })
  throughCalls.length = 0

  document.dispatch('mousemove', { clientX: 583.8, clientY: 30 })
  assert.deepEqual(throughCalls, [false], 'ceil(right) keeps the projected contour owned by toolbar')
  document.dispatch('mousemove', { clientX: 584, clientY: 30 })
  assert.deepEqual(throughCalls, [false, true], 'the half-open rounded edge yields immediately at right')
})

test('SEM-F22/J17: a contour resize re-hits a stationary pointer before the deferred layout report', async () => {
  const quiet = {
    x: 300, y: 16, left: 300, top: 16,
    right: 584, bottom: 56, width: 284, height: 40
  }
  const { callbacks, elements, layoutReports, runFrames, throughCalls, triggerToolbarResize } = createHarness({
    deferFrames: true,
    toolbarRect: quiet
  })
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 280, y: 30 }
  })
  throughCalls.length = 0
  layoutReports.length = 0

  elements.get('toolbar').rect = {
    ...quiet,
    x: 260,
    left: 260,
    width: 324
  }
  triggerToolbarResize()
  assert.deepEqual(throughCalls, [false], 'an expanded contour owns the stationary point synchronously')
  assert.deepEqual(layoutReports, [], 'the authoritative layout report may still be queued')

  elements.get('toolbar').rect = quiet
  triggerToolbarResize()
  assert.deepEqual(throughCalls, [false, true], 'a shrinking contour also yields synchronously')
  runFrames()
})

test('SEM-F22/J17: a DOM contour mutation re-hits when hidden-window resize observation is delayed', () => {
  const quiet = {
    x: 300, y: 16, left: 300, top: 16,
    right: 584, bottom: 56, width: 284, height: 40
  }
  const {
    callbacks,
    elements,
    layoutReports,
    throughCalls,
    triggerToolbarMutation
  } = createHarness({ deferFrames: true, toolbarRect: quiet })
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 280, y: 30 }
  })
  throughCalls.length = 0
  layoutReports.length = 0

  elements.get('toolbar').rect = {
    ...quiet,
    x: 260,
    left: 260,
    width: 324
  }
  triggerToolbarMutation([{ type: 'attributes', attributeName: 'style' }])
  assert.deepEqual(throughCalls, [false],
    'a DOM-driven expansion cannot wait for ResizeObserver or another mousemove')
  assert.deepEqual(layoutReports, [], 'the layout report remains deferred behind the local hit')
})

test('SEM-F22/J17: a contour change cannot reuse a pointer position invalidated by mouseleave', () => {
  const {
    callbacks,
    document,
    throughCalls,
    triggerToolbarMutation
  } = createHarness({ deferFrames: true })
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 300, y: 30 }
  })
  assert.equal(throughCalls.at(-1), false)

  document.dispatch('mouseleave', {})
  assert.equal(throughCalls.at(-1), true)
  throughCalls.length = 0
  triggerToolbarMutation([{ type: 'attributes', attributeName: 'style' }])

  assert.deepEqual(throughCalls, [],
    'a DOM change after leaving the HWND cannot make the stale local point solid again')
})

test('SEM-F22/J17: a stale same-generation toolbar rehit preserves a newer grip gesture', async () => {
  const { callbacks, dragController } = createHarness()
  await flush()
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 300, y: 30 }
  })
  dragController.start()
  assert.equal(dragController.isDragging(), true)

  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 301, y: 30 }
  })
  assert.equal(dragController.isDragging(), true)
})

test('SEM-F22/SEM-F24/J17/J19: toolbar resume forces a same-generation stationary-pointer acknowledgement', () => {
  const { callbacks, runFrames, throughCalls } = createHarness({ deferFrames: true })
  const resume = {
    schemaVersion: 1,
    generation: 4,
    phase: 'resume',
    pointer: { x: 300, y: 30 }
  }
  callbacks.interaction(resume)
  callbacks.interaction(resume)
  assert.deepEqual(throughCalls, [false, false])
  runFrames()
  assert.deepEqual(throughCalls, [false, false], 'deferred visual/layout frames cannot delay hit acknowledgement')

  callbacks.interaction({ schemaVersion: 1, generation: 5, phase: 'suspend' })
  callbacks.interaction({ ...resume, generation: 4, pointer: { x: 0, y: 0 } })
  assert.deepEqual(throughCalls, [false, false], 'an older resume cannot replace the suspended generation')
})

test('SEM-F22/SEM-F24/J17/J19: toolbar lifecycle cancellation cannot acknowledge with the pre-restore pointer', () => {
  const { callbacks, dragController, throughCalls } = createHarness()
  callbacks.interaction({
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: 300, y: 30 }
  })
  throughCalls.length = 0
  assert.equal(dragController.start(), true)

  callbacks.interaction({ schemaVersion: 1, generation: 3, phase: 'suspend' })
  assert.deepEqual(throughCalls, [], 'silent cancel must not acknowledge from the old local pointer')
  callbacks.interaction({
    schemaVersion: 1,
    generation: 3,
    phase: 'resume',
    pointer: { x: 0, y: 0 }
  })
  assert.deepEqual(throughCalls, [true])
})

test('SEM-F24/J19: toolbar exposes an accessible Fluent minimize action', async () => {
  const { actions, elements } = createHarness()
  await flush()

  const minimize = elements.get('windowControls').children
    .find((child) => child.dataset.act === 'minimize')
  assert.ok(minimize)
  assert.equal(minimize.getAttribute('aria-label'), '最小化')
  assert.equal(minimize.title, '最小化')

  for (const callback of elements.get('toolbar').listeners.get('click')) callback({ target: minimize })
  assert.deepEqual(actions, ['minimize'])
})
