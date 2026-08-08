'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { transpileRenderer } = require('./transpile-renderer')

const reducer = require('../../src/ui/shared/caption-reducer')

const root = path.resolve(__dirname, '..', '..')

class FakeClassList {
  constructor () { this.values = new Set(); this.toggleCount = 0 }
  add (...values) { values.forEach((value) => this.values.add(value)) }
  remove (...values) { values.forEach((value) => this.values.delete(value)) }
  toggle (value, force) {
    this.toggleCount += 1
    if (force) this.values.add(value)
    else this.values.delete(value)
  }
}

class FakeElement {
  constructor () {
    this.children = []
    this.classList = new FakeClassList()
    this.dataset = {}
    this.listeners = new Map()
    this.style = { setProperty () {} }
    this.clientHeight = 120
    this._textContent = ''
    this.textSetCount = 0
    this._rect = null
    this._rectResolver = null
  }
  set className (value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)) }
  set textContent (value) {
    this.textSetCount += 1
    this._textContent = String(value)
    if (value === '') this.children = []
  }
  get textContent () { return this._textContent }
  get lastChild () { return this.children.at(-1) || null }
  appendChild (child) { this.children.push(child); child.parent = this; return child }
  removeChild (child) { this.children.splice(this.children.indexOf(child), 1) }
  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }
  closest () { return null }
  getBoundingClientRect () {
    if (this._rectResolver) return this._rectResolver(this._textContent)
    return this._rect || { left: 0, top: 0, right: 900, bottom: 180 }
  }
  setPointerCapture () {}
}

function deferred () {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function flush () {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function segment (kind, text, revision, segmentId) {
  return {
    segmentId,
    sourceId: 'mic',
    sequence: revision,
    kind,
    text,
    textRevision: revision,
    translation: null,
    translationRevision: 0,
    t0: revision,
    t1: revision + 0.5
  }
}

test('SEM-F23/J18: caption renderer applies bootstrap replacement and patches only the changing partial node', async () => {
  const initial = deferred()
  const callbacks = {}
  const elements = new Map([
    ['wrap', new FakeElement()],
    ['captionCard', new FakeElement()],
    ['captions', new FakeElement()],
    ['captionFlow', new FakeElement()],
    ['liveRegion', new FakeElement()]
  ])
  const shell = {
    mouseThrough () {}, dragStart () {}, dragEnd () {}, resizeStart () {}, resizeEnd () {},
    onLock () {}, onConfig () {},
    onCaption: (callback) => { callbacks.caption = callback },
    onCaptionState: (callback) => { callbacks.state = callback },
    getLock: async () => false,
    getConfig: async () => ({}),
    getCaptionState: () => initial.promise
  }
  const document = {
    documentElement: new FakeElement(),
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement(),
    addEventListener () {},
    elementFromPoint: () => null
  }
  const window = {
    CaptionReducer: reducer,
    Appearance: { applyAppearance () {} },
    shell,
    addEventListener () {}
  }
  vm.runInNewContext(transpileRenderer(path.join(root, 'src', 'caption', 'caption.ts')), {
    ResizeObserver: class { observe () {} },
    console,
    document,
    getComputedStyle: () => ({
      getPropertyValue: (name) => name === '--fs' ? '24' : '1.25'
    }),
    requestAnimationFrame: (callback) => callback(),
    window
  })

  callbacks.state({
    schemaVersion: 1,
    revision: 4,
    sessionId: 'session-1',
    segments: [
      segment('final', '不可变原始字幕', 3, 'final-1'),
      segment('partial', '当前仍在识别', 1, 'partial-1')
    ]
  })
  initial.resolve({
    schemaVersion: 1,
    revision: 2,
    sessionId: 'session-1',
    segments: [segment('refined', '即将被回退的精修稿', 2, 'final-1')]
  })
  await flush()

  assert.deepEqual(
    elements.get('captionFlow').children.map((node) => node.textContent),
    ['不可变原始字幕', '当前仍在识别']
  )
  assert.equal(elements.get('captionFlow').children.at(-1).classList.values.has('partial'), true)

  const [stableNode, partialNode] = elements.get('captionFlow').children
  const stableTextSets = stableNode.textSetCount
  const stableClassToggles = stableNode.classList.toggleCount
  const partialTextSets = partialNode.textSetCount
  callbacks.caption({
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'partial-1',
    sequence: 5,
    revision: 2,
    kind: 'partial',
    t0: 1,
    t1: null,
    text: '当前识别假设继续增长',
    translation: null
  })

  assert.equal(elements.get('captionFlow').children[0], stableNode)
  assert.equal(stableNode.textSetCount, stableTextSets)
  assert.equal(stableNode.classList.toggleCount, stableClassToggles)
  assert.equal(partialNode.textSetCount, partialTextSets + 1)
  assert.equal(partialNode.textContent, '当前识别假设继续增长')
})

test('caption renderer reports and tombstones a fully clipped prefix without leaking text or reviving it', async () => {
  const initial = deferred()
  const callbacks = {}
  const reports = []
  const elements = new Map([
    ['wrap', new FakeElement()],
    ['captionCard', new FakeElement()],
    ['captions', new FakeElement()],
    ['captionFlow', new FakeElement()],
    ['liveRegion', new FakeElement()]
  ])
  elements.get('captionFlow')._rect = { left: 0, top: 100, right: 900, bottom: 180 }
  const rects = new Map([
    ['完全离场', { left: 0, top: 60, right: 900, bottom: 99 }],
    ['仍有可见行', { left: 0, top: 90, right: 900, bottom: 130 }],
    ['当前正在识别', { left: 0, top: 130, right: 900, bottom: 170 }],
    ['试图复活', { left: 0, top: 95, right: 900, bottom: 135 }]
  ])
  const shell = {
    mouseThrough () {}, dragStart () {}, dragEnd () {}, resizeStart () {}, resizeEnd () {},
    onLock () {}, onConfig () {},
    onCaption: (callback) => { callbacks.caption = callback },
    onCaptionState: (callback) => { callbacks.state = callback },
    getLock: async () => false,
    getConfig: async () => ({}),
    getCaptionState: () => initial.promise,
    reportCaptionViewportEviction: async (report) => { reports.push(structuredClone(report)); return true }
  }
  const document = {
    documentElement: new FakeElement(),
    getElementById: (id) => elements.get(id),
    createElement: () => {
      const node = new FakeElement()
      node._rectResolver = (text) => rects.get(text) || { left: 0, top: 130, right: 900, bottom: 170 }
      return node
    },
    addEventListener () {},
    elementFromPoint: () => null
  }
  const window = {
    CaptionReducer: reducer,
    Appearance: { applyAppearance () {} },
    shell,
    addEventListener () {}
  }
  vm.runInNewContext(transpileRenderer(path.join(root, 'src', 'caption', 'caption.ts')), {
    ResizeObserver: class { observe () {} },
    console,
    document,
    getComputedStyle: () => ({
      getPropertyValue: (name) => name === '--fs' ? '24' : '1.25'
    }),
    requestAnimationFrame: (callback) => callback(),
    window
  })

  initial.resolve({
    schemaVersion: 1,
    revision: 3,
    sessionId: 'session-1',
    segments: [
      segment('final', '完全离场', 1, 'seg-1'),
      segment('final', '仍有可见行', 2, 'seg-2'),
      segment('partial', '当前正在识别', 3, 'seg-3')
    ]
  })
  await flush()

  assert.deepEqual(reports, [{
    schemaVersion: 1,
    sessionId: 'session-1',
    throughSegmentId: 'seg-1'
  }])
  assert.deepEqual(
    elements.get('captionFlow').children.map((node) => node.textContent),
    ['仍有可见行', '当前正在识别']
  )

  callbacks.caption({
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'seg-1',
    sequence: 9,
    revision: 9,
    kind: 'refined',
    t0: 0,
    t1: 1,
    text: '试图复活',
    translation: null
  })
  callbacks.state({
    schemaVersion: 1,
    revision: 10,
    sessionId: 'session-1',
    segments: [
      segment('refined', '试图复活', 9, 'seg-1'),
      segment('final', '仍有可见行', 2, 'seg-2'),
      segment('partial', '当前正在识别', 3, 'seg-3')
    ]
  })
  await flush()

  assert.deepEqual(
    elements.get('captionFlow').children.map((node) => node.textContent),
    ['仍有可见行', '当前正在识别'],
    'same-session canonical replacement must preserve the viewport tombstone'
  )
})
