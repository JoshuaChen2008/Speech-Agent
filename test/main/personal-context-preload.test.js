'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const CHANNELS = require('../../src/main/ipc/channels')
const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')

function loadPreload (role) {
  const exposed = {}
  const listeners = new Map()
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', `${role}.js`), 'utf8')
  const localRequire = (specifier) => {
    if (specifier === 'electron') return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }
    if (specifier === './shared') {
      return {
        createWindowInteractionBridge: () => ({ dragStart: () => {}, dragEnd: () => {}, onInteractionSync: () => {} }),
        ipcRenderer: {
          invoke: async () => { throw new Error('not used') },
          on: (channel, callback) => listeners.set(channel, callback),
          removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel) },
          send: () => {}
        },
        subscribe: () => () => {}
      }
    }
    if (specifier === '../main/ipc/channels') return CHANNELS
    if (specifier === '../agent/contracts/agent-context-ui') return require('../../src/agent/contracts/agent-context-ui')
    if (specifier === '../agent/contracts/agent-model-ui') return require('../../src/agent/contracts/agent-model-ui')
    throw new Error(`unexpected preload dependency: ${specifier}`)
  }
  vm.runInNewContext(`(function (require, module, exports) { ${source}\n})`, {})
    (localRequire, { exports: {} }, {})
  return { api: exposed[role === 'settings' ? 'shell' : 'historyApi'], listeners }
}

test('SEM-F14/SEM-F30/J21: settings and history preloads expose three exact seams and drop invalid changed events', () => {
  for (const role of ['settings', 'history']) {
    const { api, listeners } = loadPreload(role)
    assert.equal(typeof api.getAgentContextOverview, 'function')
    assert.equal(typeof api.manageAgentContext, 'function')
    assert.equal(typeof api.onAgentContextChanged, 'function')
    const received = []
    const unsubscribe = api.onAgentContextChanged((event) => received.push(event))
    const deliver = listeners.get(CHANNELS.AGENT_CONTEXT_CHANGED)
    deliver({}, { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: 2 })
    deliver({}, { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: 3, scheduler: true })
    assert.deepEqual(received, [{ contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: 2 }])
    unsubscribe()
    assert.equal(listeners.has(CHANNELS.AGENT_CONTEXT_CHANGED), false)
  }
})
