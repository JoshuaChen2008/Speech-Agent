'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { loadRenderer, loadRendererFailClosed } = require('../../src/main/renderer-entry')

function harness () {
  const windows = [], statuses = [], timers = new Map()
  let timerId = 0
  class Window extends EventEmitter {
    constructor () {
      super()
      this.webContents = new EventEmitter()
      this.webContents.id = windows.length + 1
      this.destroyed = false
      this.loads = []
      windows.push(this)
    }
    isDestroyed () { return this.destroyed }
    loadFile () {
      return new Promise((resolve, reject) => this.loads.push({ resolve, reject }))
    }
    destroy () { this.destroyed = true; this.emit('closed') }
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8')
  const context = vm.createContext({
    BrowserWindow: Window, app: { isPackaged: false }, loadRenderer, loadRendererFailClosed,
    preloadPath: role => role, registerWindowRole () {}, hardenContents () {},
    applicationWindowLifecycleController: { bindAuxiliaryWindow () {}, showAuxiliaryWindow () {} },
    windowLayerController: { bindForegroundWindow () {} }, contextSourceOrigins: new Map(),
    CHANNELS: { AGENT_OPEN_STATUS: 'status', AGENT_SCOPE_REQUESTED: 'scope' },
    send (_win, channel, value) { if (channel === 'status') statuses.push(value) },
    logError () {},
    setTimeout (callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id)
  })
  vm.runInContext(`let agentWin = null, toolbarWin = {}, agentRequestedSessionId = null,
    agentOpenRequestId = 0, agentOpenWaitingTimer = null, agentOpenFailed = false,
    agentOpenPhase = 'closed', agentRendererReady = false;\n` +
    source.slice(source.indexOf('function validAgentSessionReference'), source.indexOf('function persistCaptionBounds')), context)
  return { windows, statuses, timers, open: () => context.openAgentWindow(),
    flush: async () => { await new Promise(resolve => setImmediate(resolve)) } }
}

for (const order of ['paint-first', 'load-first']) {
  test(`SEM-F38/J29: Agent opening settles with ${order} window events`, async () => {
    const h = harness(); h.open(); const win = h.windows[0]
    if (order === 'paint-first') win.emit('ready-to-show')
    win.webContents.emit('did-finish-load'); win.loads[0].resolve()
    if (order === 'load-first') win.emit('ready-to-show')
    await h.flush()
    assert.equal(h.statuses.at(-1).phase, 'ready')
    assert.equal(h.timers.size, 0)
    win.destroy()
    assert.equal(h.statuses.at(-1).phase, 'closed')
  })
}

test('SEM-F38/SEM-T04/J29: closed Agent load rejection cannot overwrite a reopened window', async () => {
  const h = harness(); h.open(); const old = h.windows[0]
  old.destroy(); h.open(); const current = h.windows[1]
  current.webContents.emit('did-finish-load'); current.loads[0].resolve(); current.emit('ready-to-show')
  await h.flush()
  old.loads[0].reject(new Error('old load rejected'))
  await h.flush()
  assert.equal(h.statuses.at(-1).phase, 'ready')
  assert.equal(current.isDestroyed(), false)
})

test('SEM-F38/SEM-T04/J29: loading failure settles and a retry starts a fresh wait deadline', async () => {
  const h = harness(); h.open(); h.windows[0].loads[0].reject(new Error('load failed'))
  await h.flush()
  assert.equal(h.statuses.at(-1).phase, 'failed')
  assert.equal(h.timers.size, 0)
  h.open()
  assert.equal(h.statuses.at(-1).phase, 'opening')
  for (const callback of [...h.timers.values()]) callback()
  assert.equal(h.statuses.at(-1).phase, 'waiting')
})

test('SEM-F38/J29: repeated open reuses the window and an obsolete retry cannot fail it', async () => {
  const h = harness(); h.open(); const win = h.windows[0]
  h.open()
  assert.equal(win.loads.length, 1)
  for (const callback of [...h.timers.values()]) callback()
  h.open()
  assert.equal(win.loads.length, 2)
  assert.equal(h.timers.size, 1)
  win.loads[0].reject(new Error('superseded navigation'))
  await h.flush()
  assert.equal(win.isDestroyed(), false)
  assert.equal(h.statuses.at(-1).phase, 'opening')
  win.webContents.emit('did-finish-load'); win.loads[1].resolve()
  await h.flush()
  assert.equal(h.statuses.at(-1).phase, 'ready')
  assert.equal(h.timers.size, 0)
  h.open()
  assert.equal(h.windows.length, 1)
  assert.equal(win.loads.length, 2)
})
