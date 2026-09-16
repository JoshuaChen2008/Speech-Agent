'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const CHANNELS = require('../../src/main/ipc/channels')
const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')
const agentSettings = require('../../src/agent/contracts/agent-settings-ui')

function loadPreload (role, options = {}) {
  const exposed = {}
  const listeners = new Map()
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', `${role}.js`), 'utf8')
  const localRequire = (specifier) => {
    if (specifier === 'electron') return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }
    if (specifier === './shared') {
      return {
        createWindowInteractionBridge: () => ({ dragStart: () => {}, dragEnd: () => {}, onInteractionSync: () => {} }),
        ipcRenderer: {
          invoke: options.invoke || (async () => { throw new Error('not used') }),
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
    if (specifier === '../agent/contracts/agent-model-presets-ui') return require('../../src/agent/contracts/agent-model-presets-ui')
    if (specifier === '../agent/contracts/agent-model-test-ui') return require('../../src/agent/contracts/agent-model-test-ui')
    if (specifier === '../agent/contracts/agent-settings-ui') return require('../../src/agent/contracts/agent-settings-ui')
    if (specifier === '../agent/contracts/session-summary-settings-ui') return require('../../src/agent/contracts/session-summary-settings-ui')
    throw new Error(`unexpected preload dependency: ${specifier}`)
  }
  vm.runInNewContext(`(function (require, module, exports) { ${source}\n})`, {})
    (localRequire, { exports: {} }, {})
  return { api: exposed[role === 'settings' ? 'shell' : 'historyApi'], listeners }
}

test('SEM-F14/SEM-F33/J25: settings preload exposes exact model actions and drops invalid reload events', async () => {
  const modelHeader = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }
  const unconfigured = {
    assignmentMode: 'unconfigured', providerKind: null, target: null,
    singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured'
  }
  const calls = []
  const { api, listeners } = loadPreload('settings', {
    invoke: async (channel, request) => {
      calls.push({ channel, request })
      return {
        ...modelHeader, ok: true, error: null,
        snapshot: {
          revision: 2, profiles: [], readinessByPurpose: {
            default: unconfigured, information_extraction: unconfigured,
            summary: unconfigured, analysis_planning: unconfigured
          }
        }
      }
    }
  })
  assert.equal(typeof api.getAgentModelCatalog, 'function')
  assert.equal(typeof api.configureAgentModel, 'function')
  assert.equal(typeof api.pullAgentModelCatalog, 'function')
  assert.equal(typeof api.onAgentModelChanged, 'function')
  assert.equal((await api.getAgentModelCatalog(modelHeader)).snapshot.revision, 2)
  assert.equal(calls[0].channel, CHANNELS.AGENT_MODEL_GET_CATALOG)

  const received = []
  const unsubscribe = api.onAgentModelChanged((event) => received.push(event))
  const deliver = listeners.get(CHANNELS.AGENT_MODEL_CHANGED)
  deliver({}, { ...modelHeader, revision: 3 })
  deliver({}, { ...modelHeader, revision: 4, credentialSlotId: 'private' })
  assert.deepEqual(received, [{ ...modelHeader, revision: 3 }])
  unsubscribe()
  assert.equal(listeners.has(CHANNELS.AGENT_MODEL_CHANGED), false)
})

test('SEM-F14/SEM-F27/J21: settings preload validates the Agent settings seam before invoking IPC', async () => {
  const calls = []
  const { api } = loadPreload('settings', {
    invoke: async (channel, request) => {
      calls.push({ channel, request })
      return {
        contract_id: agentSettings.CONTRACT_ID,
        contract_version: agentSettings.CONTRACT_VERSION,
        ok: true,
        settings: {
          agent_enabled: request.agent_enabled,
          memory_enabled: request.memory_enabled,
          cloud_disclosure_accepted: request.cloud_disclosure_accepted,
          agent_settings_revision: request.expected_revision + 1
        },
        error: null
      }
    }
  })
  const request = {
    contract_id: agentSettings.CONTRACT_ID,
    contract_version: agentSettings.CONTRACT_VERSION,
    expected_revision: 4,
    agent_enabled: true,
    memory_enabled: false,
    cloud_disclosure_accepted: true
  }
  const response = await api.setAgentSettings(request)
  assert.equal(response.settings.agent_settings_revision, 5)
  assert.equal(calls[0].channel, CHANNELS.AGENT_SETTINGS_UPDATE)
  assert.deepEqual(calls[0].request, request)
  assert.throws(() => api.setAgentSettings({ ...request, agent_enabled: 'yes' }), /must be boolean/)
})

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
