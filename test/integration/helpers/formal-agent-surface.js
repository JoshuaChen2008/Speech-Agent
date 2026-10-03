'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const React = require('react')
const { act } = React
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('../../ui/load-renderer-module')
const { registerAgentRunIpc } = require('../../../src/main/ipc/agent-run-ipc')
const { isRoleAllowed } = require('../../../src/main/ipc/access-policy')
const CHANNELS = require('../../../src/main/ipc/channels')

// Only Electron's transport and browser surface are controlled boundaries.
// The renderer, preload contracts and main services remain the real modules.
async function mountAgent (t, { service, config }) {
  const handlers = new Map(); const listeners = new Map(); const apis = {}
  registerAgentRunIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, service,
    authorize: (_event, channel) => assert.equal(isRoleAllowed(channel, 'agent'), true) })
  handlers.set(CHANNELS.CONFIG_GET, () => config.get())
  const dispose = service.subscribeChanged(event => { for (const callback of listeners.get(CHANNELS.AGENT_RUN_CHANGED) || []) callback({}, event) })
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { apis[name] = api } }, ipcRenderer: {
    invoke: (channel, request) => Promise.resolve().then(() => {
      if (!handlers.has(channel)) return { ok: false, error: { code: 'AGENT_RUN_UNAVAILABLE' }, result: null }
      return handlers.get(channel)({ sender: { id: 1 } }, request)
    }),
    on: (channel, callback) => { const set = listeners.get(channel) || new Set(); set.add(callback); listeners.set(channel, set) },
    removeListener: (channel, callback) => listeners.get(channel)?.delete(callback), send: () => {}
  } }
  function read (file) {
    const module = { exports: {} }
    const localRequire = specifier => {
      if (specifier === 'electron') return electron
      const target = path.resolve(path.dirname(file), specifier) + '.js'
      return target.startsWith(path.resolve('src/preload') + path.sep) ? read(target) : require(target)
    }
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(localRequire, module, module.exports)
    return module.exports
  }
  read(path.resolve('src/preload/agent.js'))
  const dom = new JSDOM('<div id="agent"></div>', { url: 'http://agent.test/' })
  const keys = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, apis)
  const { createRoot } = require('react-dom/client')
  const { AgentView } = await loadRendererModule(path.resolve('src/agent/agent-view.tsx'))
  const root = createRoot(document.getElementById('agent'))
  t.after(async () => {
    dispose(); await act(async () => root.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
  })
  const flush = () => act(async () => { for (let i = 0; i < 25; i += 1) await new Promise(resolve => setImmediate(resolve)) })
  const click = async element => { assert.ok(element); await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); await flush() }
  const input = async (element, value) => {
    assert.ok(element)
    await act(async () => {
      const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new window.Event('input', { bubbles: true }))
      element.dispatchEvent(new window.Event('change', { bubbles: true }))
    }); await flush()
  }
  const wait = async predicate => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); await flush()
    }
    assert.fail('formal Agent surface did not reach its expected state')
  }
  await act(async () => root.render(React.createElement(AgentView))); await flush()
  return { agent: document.getElementById('agent'), click, input, flush, wait }
}

module.exports = { mountAgent }
