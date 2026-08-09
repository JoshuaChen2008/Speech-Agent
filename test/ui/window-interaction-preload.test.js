'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const contract = require('../../src/contracts/window-interaction')
const channels = require('../../src/main/ipc/channels')

const root = path.resolve(__dirname, '..', '..')

function loadSharedPreload () {
  const listeners = new Map()
  const sent = []
  const ipcRenderer = {
    on (channel, callback) { listeners.set(channel, callback) },
    removeListener (channel, callback) {
      if (listeners.get(channel) === callback) listeners.delete(channel)
    },
    send (channel, value) { sent.push([channel, structuredClone(value)]) }
  }
  const module = { exports: {} }
  const filename = path.join(root, 'src', 'preload', 'shared.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === 'electron') return { ipcRenderer }
      if (specifier === '../main/ipc/channels') return channels
      if (specifier === '../contracts/window-interaction') return contract
      throw new Error(`unexpected preload dependency: ${specifier}`)
    }
  }, { filename })
  return { ...module.exports, emit: (value) => listeners.get(channels.WINDOW_INTERACTION_SYNC)?.({}, value), sent }
}

test('SEM-F22/SEM-F24/J17/J19: preload caches sync before callback and suppresses uninitialized or stale intents', () => {
  const harness = loadSharedPreload()
  const bridge = harness.createWindowInteractionBridge('caption')
  const observed = []
  assert.equal(bridge.dragStart(), false)
  assert.deepEqual(harness.sent, [[channels.WINDOW_INTERACTION_READY, { schemaVersion: 1 }]])
  harness.emit({
    schemaVersion: 1,
    generation: 4,
    phase: 'resume',
    pointer: { x: -2, y: 30 }
  })
  assert.equal(harness.sent.length, 1, 'preload caches before the renderer subscribes')
  bridge.onInteractionSync((value) => {
    observed.push(value)
    bridge.mouseThrough(false)
  })
  assert.equal(observed.length, 1)
  assert.deepEqual(harness.sent.at(-1), [channels.MOUSE_THROUGH, {
    schemaVersion: 1,
    generation: 4,
    ignore: false
  }])

  assert.equal(bridge.resizeStart('se'), true)
  assert.deepEqual(harness.sent.at(-1), [channels.RESIZE_START, {
    schemaVersion: 1,
    generation: 4,
    edge: 'se'
  }])
  harness.emit({ schemaVersion: 1, generation: 3, phase: 'suspend' })
  assert.equal(observed.length, 1)
  assert.equal(bridge.dragEnd(), true)
  assert.deepEqual(harness.sent.at(-1), [channels.DRAG_END, {
    schemaVersion: 1,
    generation: 4
  }])
})
