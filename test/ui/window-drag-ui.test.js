'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { transpileRenderer } = require('./transpile-renderer')

const reducer = require('../../src/ui/shared/caption-reducer')

const root = path.resolve(__dirname, '..', '..')

function source (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

class FakeEventTarget {
  constructor () { this.listeners = new Map() }
  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }
  dispatch (name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback(event)
  }
}

class FakeClassList {
  constructor () { this.values = new Set() }
  add (...values) { values.forEach((value) => this.values.add(value)) }
  remove (...values) { values.forEach((value) => this.values.delete(value)) }
  contains (value) { return this.values.has(value) }
}

class FakeElement extends FakeEventTarget {
  constructor (...classes) {
    super()
    this.classList = new FakeClassList()
    this.classList.add(...classes)
    this.dataset = {}
    this.parent = null
    this.style = { setProperty () {} }
    this.clientHeight = 120
    this.capturedPointers = []
  }
  closest (selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null
    if (className && this.classList.contains(className)) return this
    return this.parent?.closest(selector) || null
  }
  getBoundingClientRect () {
    return { x: 20, y: 20, left: 20, top: 20, right: 460, bottom: 160, width: 440, height: 140 }
  }
  setPointerCapture (pointerId) { this.capturedPointers.push(pointerId) }
}

function loadManualDrag () {
  const window = new FakeEventTarget()
  vm.runInNewContext(source('src/ui/shared/manual-window-drag.js'), { window })
  return { api: window.ManualWindowDrag, window }
}

function pointer (overrides = {}) {
  return { button: 0, isPrimary: true, pointerId: 7, ...overrides }
}

test('SEM-F22/J17: manual drag starts on primary pointerdown and closes every cancellation path once', () => {
  for (const terminal of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'beforeunload']) {
    const { api, window } = loadManualDrag()
    const handle = new FakeElement('grip')
    const classTarget = new FakeElement('toolbar')
    const calls = []
    const controller = api.bindManualWindowDrag({
      handle,
      classTarget,
      onStart: () => calls.push('start'),
      onEnd: () => calls.push('end')
    })

    handle.dispatch('pointerdown', pointer())
    assert.deepEqual(calls, ['start'], `${terminal}: start is immediate`)
    assert.equal(controller.isDragging(), true)
    assert.equal(classTarget.classList.contains('dragging'), true)
    assert.deepEqual(handle.capturedPointers, [7])

    handle.dispatch('pointerdown', pointer({ pointerId: 8 }))
    assert.deepEqual(calls, ['start'], `${terminal}: repeated start is ignored`)
    window.dispatch('pointerup', pointer({ pointerId: 8 }))
    assert.equal(controller.isDragging(), true, `${terminal}: unrelated pointer cannot cancel`)

    const target = terminal === 'lostpointercapture' ? handle : window
    const event = ['blur', 'beforeunload'].includes(terminal) ? {} : pointer()
    target.dispatch(terminal, event)
    target.dispatch(terminal, event)
    assert.deepEqual(calls, ['start', 'end'], `${terminal}: terminal path is idempotent`)
    assert.equal(controller.isDragging(), false)
    assert.equal(classTarget.classList.contains('dragging'), false)
  }
})

test('SEM-F22/J17: manual drag rejects non-primary starts and fails closed when dragStart throws', () => {
  const { api } = loadManualDrag()
  const handle = new FakeElement('grip')
  const classTarget = new FakeElement('toolbar')
  let attempts = 0
  const controller = api.bindManualWindowDrag({
    handle,
    classTarget,
    onStart: () => {
      attempts += 1
      throw new Error('renderer is gone')
    }
  })

  handle.dispatch('pointerdown', pointer({ button: 1 }))
  handle.dispatch('pointerdown', pointer({ isPrimary: false }))
  handle.dispatch('pointerdown', pointer())
  assert.equal(attempts, 1)
  assert.equal(controller.isDragging(), false)
  assert.equal(classTarget.classList.contains('dragging'), false)
})

test('SEM-F22/J17: toolbar binds manual drag only to its visible non-focusable grip', () => {
  const html = source('src/toolbar/index.html')
  const entry = source('src/toolbar/entry.ts')
  const renderer = source('src/toolbar/toolbar.ts')
  const styles = source('src/ui/shared/phases.css') + source('src/toolbar/toolbar.css')

  assert.match(html, /<script type="module" src="\.\/entry\.ts"><\/script>/)
  assert.match(entry, /manual-window-drag\.js[\s\S]*toolbar\.ts/)
  assert.match(html, /<div class="grip" id="grip"[^>]+aria-hidden="true"><\/div>/)
  assert.doesNotMatch(html, /<div class="grip"[^>]+tabindex=/)
  assert.match(renderer, /bindManualWindowDrag\(\{[\s\S]*handle: grip/)
  assert.doesNotMatch(renderer, /toolbar\.addEventListener\('pointerdown'/)
  assert.doesNotMatch(styles, /data-locked="off"[^}]*\.grip\s*\{\s*display:\s*none/)
  assert.match(styles, /\.grip\s*\{[\s\S]*width:\s*24px;[\s\S]*height:\s*30px;/)
})

function createCaptionHarness () {
  const window = new FakeEventTarget()
  const wrap = new FakeElement('wrap')
  const card = new FakeElement('caption-card')
  const hole = new FakeElement('tb-hole')
  const content = new FakeElement('caption-content')
  const captions = new FakeElement('captions')
  const flow = new FakeElement('caption-flow')
  const liveRegion = new FakeElement('live-region')
  hole.parent = card
  content.parent = card

  const elements = new Map([
    ['wrap', wrap], ['captionCard', card], ['captions', captions],
    ['captionFlow', flow], ['liveRegion', liveRegion]
  ])
  const calls = []
  const callbacks = {}
  const never = new Promise(() => {})
  const shell = {
    mouseThrough: (ignore) => calls.push(['through', ignore]),
    dragStart: (role) => calls.push(['dragStart', role]),
    dragEnd: () => calls.push(['dragEnd']),
    resizeStart: (edge) => calls.push(['resizeStart', edge]),
    resizeEnd: () => calls.push(['resizeEnd']),
    onLock: (callback) => { callbacks.lock = callback },
    onToolbarOverlap: (callback) => { callbacks.overlap = callback },
    onConfig () {}, onCaption () {}, onCaptionState () {},
    getLock: () => never,
    getConfig: () => never,
    getCaptionState: () => never,
    reportCaptionViewportEviction: async () => false
  }
  window.shell = shell
  window.CaptionReducer = reducer
  window.Appearance = { applyAppearance () {} }

  const document = new FakeEventTarget()
  document.documentElement = new FakeElement('html')
  document.getElementById = (id) => elements.get(id)
  document.createElement = () => new FakeElement()
  document.elementFromPoint = (x, y) => {
    if (x < 20 || x > 460 || y < 20 || y > 160) return wrap
    if (x >= 420 && y <= 50) return hole
    return content
  }

  vm.runInNewContext(transpileRenderer(path.join(root, 'src/caption/caption.ts')), {
    ResizeObserver: class { observe () {} },
    console,
    document,
    getComputedStyle: () => ({ getPropertyValue: (name) => name === '--fs' ? '24' : '1.25' }),
    requestAnimationFrame: (callback) => callback(),
    window
  })
  calls.length = 0
  return { callbacks, calls, card, document, shell, window }
}

test('SEM-F22/J17: caption hit priority is margin then toolbar contour then 8px resize band then drag', () => {
  const { calls, card, document, window } = createCaptionHarness()

  document.dispatch('mousemove', { clientX: 100, clientY: 80 })
  document.dispatch('mousemove', { clientX: 10, clientY: 80 })
  document.dispatch('mousemove', { clientX: 458, clientY: 22 })
  document.dispatch('mousemove', { clientX: 410, clientY: 22 })
  assert.deepEqual(calls.filter(([name]) => name === 'through'), [
    ['through', false],
    ['through', true],
    ['through', false]
  ])
  assert.equal(card.style.cursor, 'ns-resize')

  calls.length = 0
  card.dispatch('pointerdown', pointer({ clientX: 458, clientY: 22 }))
  assert.deepEqual(calls, [], 'toolbar contour wins even where it overlaps a resize corner')

  card.dispatch('pointerdown', pointer({ clientX: 100, clientY: 80 }))
  assert.deepEqual(calls, [['dragStart', 'caption']], 'caption drag starts on pointerdown')
  card.dispatch('pointerdown', pointer({ clientX: 120, clientY: 90, pointerId: 8 }))
  assert.deepEqual(calls, [['dragStart', 'caption']], 'a repeated gesture cannot restart drag')
  window.dispatch('pointerup', pointer({ pointerId: 8 }))
  assert.deepEqual(calls, [['dragStart', 'caption']], 'another pointer cannot end drag')
  window.dispatch('pointerup', pointer())
  assert.deepEqual(calls.slice(0, 2), [['dragStart', 'caption'], ['dragEnd']])

  calls.length = 0
  card.dispatch('pointerdown', pointer({ clientX: 22, clientY: 80 }))
  assert.deepEqual(calls, [['resizeStart', 'w']])
  window.dispatch('pointercancel', pointer())
  assert.deepEqual(calls.slice(0, 2), [['resizeStart', 'w'], ['resizeEnd']])
})

test('SEM-F22/J17: caption unload, blur, lost capture and lock transition close an active gesture', () => {
  for (const terminal of ['beforeunload', 'blur', 'lostpointercapture', 'lock']) {
    const { callbacks, calls, card, window } = createCaptionHarness()
    card.dispatch('pointerdown', pointer({ clientX: 100, clientY: 80 }))
    if (terminal === 'beforeunload') window.dispatch('beforeunload')
    else if (terminal === 'blur') window.dispatch('blur')
    else if (terminal === 'lostpointercapture') card.dispatch('lostpointercapture', pointer())
    else callbacks.lock(true)
    assert.deepEqual(calls.slice(0, 2), [['dragStart', 'caption'], ['dragEnd']], terminal)
    assert.equal(card.classList.contains('dragging'), false, terminal)
  }
})

test('SEM-F22/J17: caption drag and resize starts fail closed when the preload call throws', () => {
  const { calls, card, shell, window } = createCaptionHarness()
  const dragStart = shell.dragStart
  shell.dragStart = () => { throw new Error('renderer is gone') }
  assert.doesNotThrow(() => card.dispatch('pointerdown', pointer({ clientX: 100, clientY: 80 })))
  assert.equal(card.classList.contains('dragging'), false)

  shell.dragStart = dragStart
  card.dispatch('pointerdown', pointer({ clientX: 100, clientY: 80 }))
  window.dispatch('pointerup', pointer())
  assert.deepEqual(calls.slice(0, 2), [['dragStart', 'caption'], ['dragEnd']])

  calls.length = 0
  shell.resizeStart = () => { throw new Error('renderer is gone') }
  assert.doesNotThrow(() => card.dispatch('pointerdown', pointer({ clientX: 22, clientY: 80 })))
  window.dispatch('pointerup', pointer())
  assert.deepEqual(calls, [])
})

const INTERACTIVE_DRAG_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-no-drag]'
].join(', ')

test('SEM-F22/J17: titlebar drag excludes the complete interactive composed path', () => {
  const { api, window } = loadManualDrag()
  assert.equal(api.INTERACTIVE_DRAG_SELECTOR, INTERACTIVE_DRAG_SELECTOR)
  const interactive = {
    matches: (selector) => selector === INTERACTIVE_DRAG_SELECTOR
  }
  const plain = { matches: () => false }
  assert.equal(api.isInteractiveDragEvent({ composedPath: () => [plain, interactive] }), true)
  assert.equal(api.isInteractiveDragEvent({ composedPath: () => [plain] }), false)

  const titlebar = new FakeElement('titlebar')
  let starts = 0
  const controller = api.bindManualWindowDrag({
    handle: titlebar,
    canStart: (event) => !api.isInteractiveDragEvent(event),
    onStart: () => { starts += 1 }
  })
  titlebar.dispatch('pointerdown', pointer({ composedPath: () => [interactive, titlebar] }))
  assert.equal(starts, 0)
  titlebar.dispatch('pointerdown', pointer({ composedPath: () => [plain, titlebar] }))
  assert.equal(starts, 1)
  controller.end()
})

test('SEM-F22/J17: settings and subtitle history share a 48px structural titlebar and bind no body drag surface', () => {
  const settingsHtml = source('src/settings/settings.html')
  const historyHtml = source('src/history/index.html')
  const settingsEntry = source('src/settings/entry.tsx')
  const historyEntry = source('src/history/entry.js')
  const settingsScript = source('src/settings/settings-view.tsx')
  const historyScript = source('src/history/history.js')
  const settingsStyles = source('src/settings/settings.css')
  const historyStyles = source('src/history/history.css')
  const tokens = source('src/ui/shared/tokens.css')

  assert.match(settingsHtml, /<script type="module" src="\.\/entry\.tsx"><\/script>/)
  assert.match(historyHtml, /<script type="module" src="\.\/entry\.js"><\/script>/)
  assert.match(settingsEntry, /manual-window-drag\.js[\s\S]*SettingsView/)
  assert.match(historyEntry, /manual-window-drag\.js[\s\S]*history\.js/)
  for (const script of [settingsScript, historyScript]) {
    assert.match(script, /bindManualWindowDrag\(\{[\s\S]*handle: titlebar(?:\.current)?/)
    assert.match(script, /canStart: \(event(?:: Event)?\) => !(?:manualWindowDrag|drag)\.isInteractiveDragEvent\(event\)/)
    assert.doesNotMatch(script, /titlebar\.addEventListener\('pointerdown'/)
    assert.doesNotMatch(script, /document\.(?:body|documentElement)\.addEventListener\('pointerdown'/)
  }

  assert.match(tokens, /--surface-window-titlebar:/)
  assert.match(tokens, /--border-window-titlebar:/)
  assert.equal((tokens.match(/--surface-window-titlebar:/g) || []).length, 3)
  assert.equal((tokens.match(/--border-window-titlebar:/g) || []).length, 3)
  for (const styles of [settingsStyles, historyStyles]) {
    assert.match(styles, /\.titlebar\s*\{[\s\S]*height:\s*48px;/)
    assert.match(styles, /background:\s*var\(--surface-window-titlebar\)/)
    assert.match(styles, /border-bottom:\s*1px solid var\(--border-window-titlebar\)/)
  }
  assert.match(settingsStyles, /height:\s*calc\(100% - 48px\)/)
  assert.match(settingsStyles, /inset:\s*48px 0 0/)
})
