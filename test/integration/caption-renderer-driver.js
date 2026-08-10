'use strict'

const path = require('node:path')
const vm = require('node:vm')
const reducer = require('../../src/ui/shared/caption-reducer')
const { transpileRenderer } = require('../ui/transpile-renderer')

const ROOT = path.resolve(__dirname, '..', '..')

class EventTargetStub {
  constructor () { this.listeners = new Map() }
  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }
  dispatch (name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback(event)
  }
}

class ClassListStub {
  constructor (...values) { this.values = new Set(values) }
  add (...values) { values.forEach((value) => this.values.add(value)) }
  remove (...values) { values.forEach((value) => this.values.delete(value)) }
  contains (value) { return this.values.has(value) }
  toggle (value, force) {
    if (force === true) this.values.add(value)
    else if (force === false) this.values.delete(value)
    else if (this.values.has(value)) this.values.delete(value)
    else this.values.add(value)
  }
}

class ElementStub extends EventTargetStub {
  constructor (classes = [], rect = null) {
    super()
    this.classList = new ClassListStub(...classes)
    this.dataset = {}
    this.parent = null
    this.children = []
    this.clientHeight = 120
    this.rect = rect
    this.style = { setProperty () {} }
    this.textContent = ''
  }
  closest (selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null
    if (className && this.classList.contains(className)) return this
    return this.parent?.closest(selector) || null
  }
  getBoundingClientRect () {
    return this.rect || { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  appendChild (child) { this.children.push(child); child.parent = this; return child }
  removeChild (child) { this.children.splice(this.children.indexOf(child), 1) }
  get lastChild () { return this.children.at(-1) || null }
  setPointerCapture (pointerId) { this.capturedPointerId = pointerId }
  releasePointerCapture (pointerId) { if (this.capturedPointerId === pointerId) this.capturedPointerId = null }
}

function createCaptionRendererDriver ({
  cardRect,
  toolbarHoleRect,
  mouseThrough,
  dragStart,
  dragEnd,
  resizeStart,
  resizeEnd
}) {
  const window = new EventTargetStub()
  const wrap = new ElementStub(['wrap'])
  const card = new ElementStub(['caption-card'], cardRect)
  const hole = new ElementStub(['tb-hole'], toolbarHoleRect)
  const content = new ElementStub(['caption-content'])
  const captions = new ElementStub(['captions'])
  const flow = new ElementStub(['caption-flow'])
  const liveRegion = new ElementStub(['live-region'])
  hole.parent = card
  content.parent = card
  const callbacks = {}
  const never = new Promise(() => {})
  const shell = {
    mouseThrough,
    dragStart,
    dragEnd,
    resizeStart,
    resizeEnd,
    onInteractionSync: (callback) => { callbacks.interaction = callback },
    onLock: (callback) => { callbacks.lock = callback },
    onToolbarOverlap: (callback) => { callbacks.overlap = callback },
    onConfig () {},
    onCaption () {},
    onCaptionState () {},
    getLock: () => never,
    getConfig: () => never,
    getCaptionState: () => never,
    reportCaptionViewportEviction: async () => false
  }
  window.shell = shell
  window.CaptionReducer = reducer
  window.Appearance = { applyAppearance () {} }

  const elements = new Map([
    ['wrap', wrap], ['captionCard', card], ['captions', captions],
    ['captionFlow', flow], ['liveRegion', liveRegion]
  ])
  const document = new EventTargetStub()
  document.documentElement = new ElementStub(['html'])
  document.getElementById = (id) => elements.get(id)
  document.createElement = () => new ElementStub()
  document.elementFromPoint = (x, y) => {
    const inside = (rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    if (!inside(cardRect)) return wrap
    if (inside(toolbarHoleRect)) return hole
    return content
  }

  vm.runInNewContext(transpileRenderer(path.join(ROOT, 'src', 'caption', 'caption.ts')), {
    ResizeObserver: class { observe () {} },
    cancelAnimationFrame () {},
    console,
    document,
    getComputedStyle: () => ({ getPropertyValue: (name) => name === '--fs' ? '24' : '1.25' }),
    requestAnimationFrame: (callback) => callback(),
    window
  })

  return Object.freeze({
    lock: (value) => callbacks.lock(value),
    move: (x, y) => document.dispatch('mousemove', { clientX: x, clientY: y }),
    pointerDown: (x, y, pointerId = 7) => card.dispatch('pointerdown', {
      button: 0, buttons: 1, isPrimary: true, pointerId, clientX: x, clientY: y
    }),
    pointerMove: (x, y, pointerId = 7, buttons = 1) => window.dispatch('pointermove', {
      button: 0, buttons, isPrimary: true, pointerId, clientX: x, clientY: y
    }),
    pointerUp: (pointerId = 7) => window.dispatch('pointerup', {
      button: 0, buttons: 0, isPrimary: true, pointerId
    }),
    sync: (value) => callbacks.interaction(value)
  })
}

module.exports = { createCaptionRendererDriver }
