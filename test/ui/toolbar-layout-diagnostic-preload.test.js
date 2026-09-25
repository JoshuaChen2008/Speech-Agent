'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { createRequire } = require('node:module')
const CHANNELS = require('../../src/main/ipc/channels')

function preload (enabled, brokenDiagnostic = false) {
  const filename = path.resolve(__dirname, '../../src/preload/toolbar.js')
  const requireFromPreload = createRequire(filename)
  const sent = []
  const exposed = {}
  const ipcRenderer = {
    on () {},
    send (channel, payload) { sent.push([channel, payload]); return 7 },
    invoke () { return Promise.resolve({ generation: 2 }) }
  }
  const sharedFilename = path.resolve(__dirname, '../../src/preload/shared.js')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(sharedFilename, 'utf8'), {
    module, require: (id) => id === 'electron' ? { ipcRenderer } : requireFromPreload(id)
  })
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    process: { env: enabled ? { LIVE_SUBTITLE_TOOLBAR_LAYOUT_DIAGNOSTIC: '1' } : {} },
    require: (id) => id === 'electron'
      ? { contextBridge: { exposeInMainWorld (name, value) { exposed[name] = value } } }
      : id === './shared' ? module.exports
        : id === './toolbar-layout-diagnostic' && brokenDiagnostic
          ? { RENDERER_STAGES: [], createRecorder: () => ({ record () { throw new Error('diagnostic failed') } }) }
          : requireFromPreload(id)
  })
  return { bridge: exposed.shell, sent, ipcRenderer }
}

test('SEM-F22/F14/J17: diagnostic bridge is opt-in and sends the same payload exactly once', () => {
  const report = { generation: 2, rect: { x: 16, y: 16, width: 568, height: 40 } }
  for (const enabled of [false, true]) {
    const harness = preload(enabled)
    assert.equal(Object.hasOwn(harness.bridge, 'toolbarLayoutDiagnostic'), enabled)
    assert.equal(harness.bridge.reportToolbarLayout(report), 7)
    assert.deepEqual(harness.sent.filter(([channel]) => channel === CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT),
      [[CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, report]])
    if (enabled) {
      harness.bridge.toolbarLayoutDiagnostic.record('private text', 2)
      const snapshot = harness.bridge.toolbarLayoutDiagnostic.snapshot(Date.now(), 2)
      assert.deepEqual(snapshot.entries.map((entry) => entry.stage), ['send-attempted', 'sent'])
      assert.equal(JSON.stringify(snapshot).includes('568'), false)
    }
  }
})

test('SEM-F22/J17: observed preload send throws the original exception without marking sent', () => {
  const harness = preload(true)
  const failure = new Error('external IPC unavailable')
  harness.ipcRenderer.send = () => { throw failure }
  assert.throws(() => harness.bridge.reportToolbarLayout({ generation: 2 }), (error) => error === failure)
  const snapshot = harness.bridge.toolbarLayoutDiagnostic.snapshot(Date.now(), 2)
  assert.deepEqual(snapshot.entries.map((entry) => entry.stage), ['send-attempted', 'send-failed'])
})

test('SEM-F22/J17: recorder failure neither blocks IPC nor replaces the original IPC failure', () => {
  const harness = preload(true, true)
  assert.equal(harness.bridge.reportToolbarLayout({ generation: 2 }), 7)
  const failure = new Error('original IPC failure')
  harness.ipcRenderer.send = () => { throw failure }
  assert.throws(() => harness.bridge.reportToolbarLayout({ generation: 2 }), (error) => error === failure)
})
