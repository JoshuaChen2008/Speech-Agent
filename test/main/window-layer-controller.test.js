'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

class FakeEmitter {
  constructor () { this.listeners = new Map() }
  on (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }
  emit (name, ...args) {
    for (const callback of this.listeners.get(name) || []) callback(...args)
  }
}

class FakeWindow extends FakeEmitter {
  constructor (name, calls) {
    super()
    this.name = name
    this.calls = calls
    this.destroyed = false
    this.failMove = false
    this.failPromote = false
    this.failDemote = false
    this.webContents = new FakeEmitter()
  }
  isDestroyed () { return this.destroyed }
  setAlwaysOnTop (on, level) {
    this.calls.push([this.name, 'always-on-top', on, level || null])
    if (on && this.failPromote) throw new Error('promote failed')
    if (!on && this.failDemote) throw new Error('demote failed')
  }
  moveTop () {
    this.calls.push([this.name, 'move-top'])
    if (this.failMove) throw new Error('move failed')
  }
}

function fixture () {
  const { WindowLayerController } = require('../../src/main/window-layer-controller')
  const calls = []
  const faults = []
  const caption = new FakeWindow('caption', calls)
  const toolbar = new FakeWindow('toolbar', calls)
  const settings = new FakeWindow('settings', calls)
  const history = new FakeWindow('history', calls)
  const controller = new WindowLayerController({
    getCaptionWindow: () => caption,
    getToolbarWindow: () => toolbar,
    onFault: (fault) => faults.push(fault)
  })
  controller.bindForegroundWindow(settings, 'settings')
  controller.bindForegroundWindow(history, 'history')
  return { calls, caption, controller, faults, history, settings, toolbar }
}

test('SEM-F22/J17: focus promotes exactly one normal window and blur restores its normal level', () => {
  const { calls, controller, history, settings } = fixture()

  settings.emit('focus')
  assert.equal(controller.getActiveRole(), 'settings')
  history.emit('focus')
  assert.equal(controller.getActiveRole(), 'history')
  settings.emit('blur')
  assert.equal(controller.getActiveRole(), 'history')
  history.emit('blur')
  assert.equal(controller.getActiveRole(), null)

  assert.deepEqual(calls, [
    ['settings', 'always-on-top', true, 'screen-saver'],
    ['settings', 'move-top'],
    ['settings', 'always-on-top', false, null],
    ['history', 'always-on-top', true, 'screen-saver'],
    ['history', 'move-top'],
    ['history', 'always-on-top', false, null]
  ])
})

test('SEM-F22/J17: overlay restacking keeps toolbar above caption and the focused normal window above both', () => {
  const { calls, controller, history } = fixture()
  history.emit('focus')
  calls.length = 0

  controller.restoreWindowStack()
  assert.deepEqual(calls, [
    ['caption', 'move-top'],
    ['toolbar', 'move-top'],
    ['history', 'move-top']
  ])
})

test('SEM-F22/J17: close, renderer destruction and layer failures clean up idempotently with fixed diagnostics', () => {
  const { calls, controller, faults, history, settings } = fixture()

  settings.emit('focus')
  settings.webContents.emit('destroyed')
  settings.webContents.emit('destroyed')
  assert.equal(controller.getActiveRole(), null)
  assert.equal(calls.filter((call) => call[0] === 'settings' && call[2] === false).length, 1)

  history.failPromote = true
  history.emit('focus')
  assert.equal(controller.getActiveRole(), null)
  assert.deepEqual(faults, [{ role: 'history', code: 'promote-failed' }])
  assert.deepEqual(calls.slice(-2), [
    ['history', 'always-on-top', true, 'screen-saver'],
    ['history', 'always-on-top', false, null]
  ])

  history.destroyed = true
  history.emit('closed')
  history.emit('blur')
  assert.equal(controller.getActiveRole(), null)
})

test('SEM-F22/J17: a failed demotion cannot block the next focused normal window', () => {
  const { controller, faults, history, settings } = fixture()
  settings.emit('focus')
  settings.failDemote = true

  history.emit('focus')
  assert.equal(controller.getActiveRole(), 'history')
  assert.deepEqual(faults, [{ role: 'settings', code: 'demote-failed' }])
})

test('SEM-F22/J17: main routes every foreground and overlay z-order entry through the controller', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8')

  assert.match(main, /new WindowLayerController\(\{/)
  assert.match(main, /windowLayerController\.bindForegroundWindow\(settingsWin, 'settings'\)/)
  assert.match(main, /windowLayerController\.bindForegroundWindow\(historyWin, 'history'\)/)
  assert.match(main, /function dock \(\{ restoreStack = true \} = \{\}\)[\s\S]*if \(!sameBounds\([\s\S]*if \(restoreStack\) windowLayerController\.restoreWindowStack\(\)/)
  assert.match(main, /settingsWin\.show\(\)[\s\S]*settingsWin\.focus\(\)/)
  assert.match(main, /historyWin\.show\(\)[\s\S]*historyWin\.focus\(\)/)
})
