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
const rawFixtures = require('../../src/agent/contracts/fixtures/agent-model-ui/v1.0.0/scenarios.json')
const {
  assertCatalogResponse, assertConfigureResponse, assertPullResponse
} = require('../../src/agent/contracts/agent-model-ui')
const { assertGetPresetsResponse } = require('../../src/agent/contracts/agent-model-presets-ui')
const { assertTestRequest, assertTestResponse } = require('../../src/agent/contracts/agent-model-test-ui')
const { publicPresetCatalog } = require('../../src/agent/model-access/preset-registry')

const root = path.resolve(__dirname, '..', '..')

function fixture (index) {
  const entry = rawFixtures[index]
  if (entry.kind === 'catalogResponse') assertCatalogResponse(entry.payload)
  else if (entry.kind === 'configureResponse') assertConfigureResponse(entry.payload)
  else if (entry.kind === 'pullResponse') assertPullResponse(entry.payload)
  return structuredClone(entry.payload)
}

async function loadAgentModelPane () {
  const filename = path.join(root, 'src', 'settings', 'agent-model-pane.tsx')
  const exports = await loadRendererModule(filename)
  return exports.AgentModelPane
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flush (delay = 0) {
  await act(async () => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function click (element) { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }

function typeInto (input, value) {
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function findButton (scope, text) {
  return [...scope.querySelectorAll('button')].find((button) => button.textContent === text)
}

async function createHarness (options = {}) {
  const AgentModelPane = await loadAgentModelPane()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const globalKeys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent']
  const previous = Object.fromEntries(globalKeys.map((key) => [key, global[key]]))
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent
  })
  global.IS_REACT_ACT_ENVIRONMENT = true

  // "resting + 一次性覆盖" 队列：pushXxx() 提交的值在下一次调用时被消费并成为新的
  // resting 值；调用次数超过已提交的覆盖值时，持续返回最近一次的 resting 值，
  // 不因为额外的一次调用（例如冲突分支里的自动重读）而回退到更早的响应。
  function makeResponder (initial) {
    let resting = initial
    const overrides = []
    return {
      push (value) { overrides.push(value) },
      next () {
        if (overrides.length > 0) { resting = overrides.shift() }
        return resting
      }
    }
  }

  const catalogResponder = makeResponder(options.catalogResponses?.[0])
  for (const extra of (options.catalogResponses ?? []).slice(1)) catalogResponder.push(extra)
  const configureResponder = makeResponder(options.configureResponses?.[0])
  for (const extra of (options.configureResponses ?? []).slice(1)) configureResponder.push(extra)
  const pullResponder = makeResponder(options.pullResponses?.[0])
  for (const extra of (options.pullResponses ?? []).slice(1)) pullResponder.push(extra)

  const catalogCalls = []
  const configureCalls = []
  const pullCalls = []
  const presetCalls = []
  const testCalls = []
  let changedHandler = null

  const shell = {
    getAgentModelCatalog: async (request) => { catalogCalls.push(request); return catalogResponder.next() },
    onAgentModelChanged: (callback) => { changedHandler = callback; return () => { changedHandler = null } },
    configureAgentModel: async (request) => { configureCalls.push(request); return configureResponder.next() },
    pullAgentModelCatalog: async (request) => { pullCalls.push(request); return pullResponder.next() }
  }
  if (options.presets) {
    shell.getAgentModelPresets = async (request) => {
      presetCalls.push(request)
      return typeof options.presets === 'function' ? options.presets(request) : options.presets
    }
  }
  if (options.testSavedAgentModel) {
    shell.testSavedAgentModel = async (request) => {
      testCalls.push(request)
      return typeof options.testSavedAgentModel === 'function' ? options.testSavedAgentModel(request) : options.testSavedAgentModel
    }
  }
  if (options.cancelSavedAgentModel) {
    shell.cancelSavedAgentModel = async (request) => options.cancelSavedAgentModel(request)
  }

  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentModelPane, { shell })))
  await flush()

  return {
    dom, shell, catalogCalls, configureCalls, pullCalls, presetCalls, testCalls,
    emitChanged (event) { if (typeof changedHandler === 'function') changedHandler(event) },
    pushCatalog (response) { catalogResponder.push(response) },
    pushConfigure (response) { configureResponder.push(response) },
    pushPull (response) { pullResponder.push(response) },
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    }
  }
}

test('SEM-F33/J25: 日常选择、取消与只读测试状态使用当前配置', async (t) => {
  const testResponse = assertTestResponse({ contractId: 'agent-model-test-ui', contractVersion: '1.0.0',
    testId: 'settings-placeholder', ok: true, status: 'success', nextAction: 'none' })
  const harness = await createHarness({ catalogResponses: [fixture(1)], testSavedAgentModel: (request) => ({ ...testResponse, testId: request.testId }) })
  t.after(() => harness.dispose())
  assert.equal(document.querySelector('.agent-model-wizard'), null)
  assert.match(document.querySelector('.agent-model-default-summary').textContent, /DeepSeek · deepseek-v4-flash/)
  assert.equal(document.querySelectorAll('input[type="password"]').length, 0)
  assert.match(document.querySelector('.agent-model-default-summary').textContent, /尚未测试/)
  await act(async () => click(findButton(document, '选择模型')))
  await act(async () => typeInto(document.querySelector('input[aria-label="搜索模型"]'), 'deepseek'))
  await act(async () => click(findButton(document, '取消')))
  assert.equal(harness.configureCalls.length, 0)
  await act(async () => click(findButton(document, '测试模型')))
  await flush()
  assert.equal(harness.testCalls.length, 1)
  assert.match(document.querySelector('.agent-model-default-summary').textContent, /模型已正常响应本次测试/)
  harness.pushCatalog(fixture(2))
  harness.emitChanged({ revision: 4 })
  await flush()
  assert.match(document.querySelector('.agent-model-default-summary').textContent, /尚未测试/)
})

test('SEM-F33/J25: 共用表单展开未知能力并保留未保存草稿', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(0)], configureResponses: [fixture(5)] })
  t.after(() => harness.dispose())
  const manage = document.querySelector('.agent-model-profiles')
  await act(async () => click(manage.querySelector('summary')))
  await act(async () => click(findButton(manage, '编辑')))
  assert.equal(document.querySelectorAll('input[type="password"]').length, 1)
  assert.equal(document.querySelector('#agent-key').value, '')
  assert.match(document.querySelector('.agent-model-editor').textContent, /API 密钥/)
  await act(async () => typeInto(document.querySelector('#agent-key'), 'synthetic-secret'))
  await act(async () => typeInto(document.querySelector('#agent-model'), 'custom-model'))
  await flush(10)
  await act(async () => click(findButton(document, '保存')))
  await flush(10) // native details toggle must not clear the validation message
  assert.match(document.querySelector('.agent-model-editor [role="alert"]').textContent, /六项模型能力/)
  assert.equal(document.querySelector('.agent-model-editor details').open, true)
  assert.equal(harness.configureCalls.length, 0)
  assert.equal(document.querySelector('#agent-model').value, 'custom-model')
})

test('SEM-F33/SEM-T04/J25: 新增连接缺少密钥时在当前表单提示并聚焦', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(0)] })
  t.after(() => harness.dispose())
  const manage = document.querySelector('.agent-model-profiles')
  await act(async () => click(manage.querySelector('summary')))
  await act(async () => click(findButton(manage, '新增服务')))
  await act(async () => typeInto(document.querySelector('#agent-url'), 'https://api.example.test/v1'))
  await act(async () => click(findButton(document, '保存')))
  await flush(10)
  assert.match(document.querySelector('.agent-model-editor [role="alert"]').textContent, /API 密钥/)
  assert.equal(document.activeElement?.id, 'agent-key')
  assert.equal(harness.configureCalls.length, 0)
})

test('SEM-F33/J25: 服务保存逐条回执，revision 冲突保留输入', async (t) => {
  const response = fixture(6)
  const harness = await createHarness({ catalogResponses: [fixture(1)], configureResponses: [response] })
  t.after(() => harness.dispose())
  const manage = document.querySelector('.agent-model-profiles')
  await act(async () => click(manage.querySelector('summary')))
  await act(async () => click(findButton(manage, '编辑')))
  await act(async () => typeInto(document.querySelector('#agent-label'), 'DeepSeek New'))
  await act(async () => click(findButton(document, '保存')))
  await flush()
  assert.equal(harness.configureCalls.length, 1)
  assert.equal(harness.configureCalls[0].command.type, 'updateProfile')
  assert.equal(harness.configureCalls[0].command.expectedRevision, 3)
  assert.equal(document.querySelector('#agent-label').value, 'DeepSeek New')
  assert.match(document.querySelector('.agent-model-editor [role="alert"]').textContent, /连接未保存/)
})

test('SEM-F23/J18: 不可用时只显示读取资料错误与重试', async (t) => {
  const unavailable = { contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: false,
    snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }
  const harness = await createHarness({ catalogResponses: [unavailable] })
  t.after(() => harness.dispose())
  assert.equal(document.querySelector('[role="alert"]').textContent, '助手模型配置暂时不可用。')
  assert.equal(document.querySelector('.agent-model-profiles'), null)
  harness.pushCatalog(fixture(1))
  await act(async () => click(findButton(document, '重试')))
  assert.notEqual(document.querySelector('.agent-model-default-summary'), null)
})
