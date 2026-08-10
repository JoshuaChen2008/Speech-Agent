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
    return { x: 184, y: 16, width: 400, height: 40, left: 184, top: 16, right: 584, bottom: 56 }
  }
}

async function flush () {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createHarness ({ deferFrames = false } = {}) {
  const ids = ['wrap', 'toolbar', 'grip', 'status', 'commands', 'windowControls']
  const elements = new Map(ids.map((id) => [id, new FakeElement('div')]))
  elements.get('toolbar').classList.add('toolbar')
  const callbacks = {}
  const actions = []
  const layoutReports = []
  const observedLayoutTargets = []
  const throughCalls = []
  let dragController = null
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
        let active = false
        dragController = {
          cancel () {
            if (!active) return
            active = false
            options.onActiveChange?.(false)
          },
          end () {},
          isDragging: () => active,
          start () {
            if (options.onStart?.() === false) return false
            active = true
            options.onActiveChange?.(true)
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
      constructor (callback) { this.callback = callback }
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

  assert.deepEqual(observedLayoutTargets, [elements.get('toolbar')])
  assert.deepEqual(layoutReports, [{
    generation: 7,
    rect: { x: 184, y: 16, width: 400, height: 40 }
  }])
})

/* 穿透状态一翻转，光标就换主人：穿透时由下面那个应用画，实心时才是本窗的箭头。
   所以判定每抖一次用户就看见光标闪一次。进入必须精确（否则条外一圈会白白吃掉
   下面应用的点击），离开必须粘住（否则边缘 1px 抖动就来回翻）。
   条的轮廓在本 harness 里是 184..584 × 16..56。 */
test('SEM-F22/J17: toolbar mouse-through enters on the exact contour and leaves only past the hysteresis band', async () => {
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
  assert.deepEqual(throughCalls, [], '离开轮廓 4px 仍在迟滞带内，不翻转')

  document.dispatch('mousemove', { clientX: 592, clientY: 30 })
  assert.deepEqual(throughCalls, [true], '超出 6px 才恢复穿透')

  throughCalls.length = 0
  document.dispatch('mousemove', { clientX: 588, clientY: 30 })
  assert.deepEqual(throughCalls, [], '进入不带迟滞：真实轮廓之外一律穿透')

  document.dispatch('mousemove', { clientX: 580, clientY: 30 })
  assert.deepEqual(throughCalls, [false], '回到真实轮廓内才变实心')

  throughCalls.length = 0
  document.dispatch('mouseleave', {})
  assert.deepEqual(throughCalls, [true], '指针离开整个窗口时不能卡在实心态')
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
