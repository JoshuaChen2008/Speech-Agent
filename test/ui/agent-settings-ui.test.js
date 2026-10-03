'use strict'

require('./dom-bootstrap')

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('./load-renderer-module')

const root = path.resolve(__dirname, '..', '..')
const header = { contract_id: 'speech-agent.agent-settings.ui', contract_version: '1.0.0' }

async function flush () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function click (element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

async function createHarness (response, summaryResponse = null) {
  const { AgentSettingsPane } = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-settings-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const calls = []
  const summaryCalls = []
  let refreshCount = 0
  const shell = {
    setAgentSettings: async (request) => { calls.push(request); return response },
    setSummaryMemoryPreference: async (request) => {
      summaryCalls.push(request)
      return summaryResponse || {
        contract_id: 'speech-agent.session-summary-settings.ui',
        contract_version: '1.0.0',
        ok: true,
        settings: { summary_use_memory: request.summary_use_memory, agent_settings_revision: request.expected_revision + 1 },
        error: null
      }
    }
  }
  const config = {
    agentEnabled: false,
    memoryEnabled: true,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 3,
    summaryUseMemory: true
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentSettingsPane, {
    shell, config, onConfigRefresh: async () => { refreshCount += 1 }
  })))
  await flush()
  return {
    calls,
    summaryCalls,
    get refreshCount () { return refreshCount },
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    }
  }
}

test('SEM-F27/SEM-F30/J21: Agent settings surface exposes the three product controls and sends a bounded exact update', async (t) => {
  const harness = await createHarness({
    ...header,
    ok: true,
    settings: { agent_enabled: true, memory_enabled: true, cloud_disclosure_accepted: false, agent_settings_revision: 4 },
    error: null
  })
  t.after(() => harness.dispose())
  assert.match(document.body.textContent, /AI 助手/)
  assert.match(document.body.textContent, /个人记忆/)
  assert.match(document.body.textContent, /云端数据使用说明/)
  assert.match(document.body.textContent, /问题、相关字幕和记忆发送到你配置的模型服务商/)
  assert.match(document.body.textContent, /以该服务商的政策为准/)
  await act(async () => click(document.querySelector('input[aria-label="启用 AI 助手"]')))
  await flush()
  assert.deepEqual(harness.calls, [{
    ...header,
    expected_revision: 3,
    agent_enabled: true,
    memory_enabled: true,
    cloud_disclosure_accepted: false
  }])
  assert.equal(harness.refreshCount, 1)
  assert.equal(document.body.textContent.includes('agent-settings:update'), false)
})

test('SEM-T04/J21: settings conflict is surfaced as an actionable message without exposing private failure details', async (t) => {
  const harness = await createHarness({
    ...header,
    ok: false,
    settings: null,
    error: { code: 'AGENT_SETTINGS_REVISION_CONFLICT', next_action: 'reload' }
  })
  t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('input[aria-label="允许发送到云端模型"]')))
  await flush()
  assert.match(document.body.textContent, /设置已在别处更新，请重新载入后再试/)
  assert.doesNotMatch(document.body.textContent, /stack|path|credential|prompt/i)
})

test('SEM-F38/J29: settings expose the beginner summary memory toggle through its exact contract', async (t) => {
  const harness = await createHarness({
    ...header,
    ok: true,
    settings: { agent_enabled: false, memory_enabled: true, cloud_disclosure_accepted: false, agent_settings_revision: 4 },
    error: null
  })
  t.after(() => harness.dispose())
  assert.match(document.body.textContent, /总结时参考记忆/)
  assert.match(document.body.textContent, /关闭后，总结只依据本次会话，自动整理记忆不受影响/)
  await act(async () => click(document.querySelector('input[aria-label="总结时参考记忆"]')))
  await flush()
  assert.deepEqual(harness.summaryCalls, [{
    contract_id: 'speech-agent.session-summary-settings.ui',
    contract_version: '1.0.0',
    expected_revision: 3,
    summary_use_memory: false
  }])
  assert.equal(harness.refreshCount, 1)
})
