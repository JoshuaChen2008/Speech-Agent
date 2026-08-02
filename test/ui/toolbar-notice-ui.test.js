'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

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
}

async function flush () {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createHarness () {
  const ids = ['wrap', 'toolbar', 'grip', 'status', 'commands', 'windowControls']
  const elements = new Map(ids.map((id) => [id, new FakeElement('div')]))
  elements.get('toolbar').classList.add('toolbar')
  const callbacks = {}
  const actions = []
  const shell = {
    mouseThrough () {}, dragStart () {}, dragEnd () {}, lockToggle () {},
    action: (name) => actions.push(name),
    onLock: (callback) => { callbacks.lock = callback },
    onConfig: (callback) => { callbacks.config = callback },
    onSnapshot: (callback) => { callbacks.snapshot = callback },
    onRefinementNotice: (callback) => { callbacks.notice = callback },
    getLock: async () => false,
    getConfig: async () => ({}),
    getSnapshot: async () => ({ revision: 1 }),
    getRefinementNotice: async () => null,
    command: async () => ({ ok: true })
  }
  const document = {
    documentElement: new FakeElement('html'),
    getElementById: (id) => elements.get(id),
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener () {},
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
    addEventListener () {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'toolbar', 'toolbar.js'), 'utf8'), {
    console,
    document,
    requestAnimationFrame: (callback) => callback(),
    window
  })
  return { actions, callbacks, elements }
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
