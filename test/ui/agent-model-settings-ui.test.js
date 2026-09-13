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
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
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

test('S5-UX/J25(S2 Core 子边界): 先订阅再读取 snapshot；changed 更高 revision 触发重读，迟到的较旧 revision 被丢弃', async (t) => {
  const initial = fixture(1)
  const harness = await createHarness({ catalogResponses: [initial] })
  t.after(() => harness.dispose())

  assert.equal(document.querySelectorAll('[data-profile-id]').length, 1)
  assert.match(document.querySelector('[data-profile-id="deepseek"]').textContent, /api\.deepseek\.com/)

  const callsBefore = harness.catalogCalls.length
  harness.emitChanged({ contractId: 'agent-model-ui', contractVersion: '1.0.0', revision: 1 })
  await flush()
  assert.equal(harness.catalogCalls.length, callsBefore, '过期 revision 的 changed 事件不应触发重读')

  const higher = fixture(2)
  harness.pushCatalog(higher)
  harness.emitChanged({ contractId: 'agent-model-ui', contractVersion: '1.0.0', revision: 4 })
  await flush()
  assert.notEqual(document.querySelector('[data-profile-id="gateway"]'), null, '更高 revision 的 changed 事件应触发重读并采纳新 snapshot')
})

test('S5-UX/J25(S2 Core 子边界): MODEL_ACCESS_UNAVAILABLE 时进入只读不可用并提供重试，不呈现空档案', async (t) => {
  const unavailable = {
    contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: false, snapshot: null,
    error: { code: 'MODEL_ACCESS_UNAVAILABLE' }
  }
  assertCatalogResponse(unavailable)
  const harness = await createHarness({ catalogResponses: [unavailable] })
  t.after(() => harness.dispose())

  assert.equal(document.querySelector('[role="alert"]').textContent, 'Agent 模型配置暂时不可用。')
  assert.equal(document.querySelectorAll('[data-profile-id]').length, 0)
  assert.equal(document.querySelector('.agent-model-profiles'), null, '不可用时不得渲染档案区域，避免读成空配置')

  harness.pushCatalog(fixture(1))
  await act(async () => click(findButton(document, '重试')))
  await flush()
  assert.equal(document.querySelectorAll('[data-profile-id]').length, 1)
})

test('S5-UX/J25(S2 Core 子边界): 空 model 模板展示官方建议且未知能力标注为「未确认」，点击建议只预填不写库', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(0)] })
  t.after(() => harness.dispose())

  const card = document.querySelector('[data-profile-id="deepseek"]')
  assert.match(card.textContent, /deepseek-v4-flash/)
  assert.equal(card.querySelectorAll('[data-model-id]').length, 0, '模板初始为空 model')

  const applyButton = findButton(card, '用这条建议填写')
  await act(async () => click(applyButton))
  await flush()

  const modelIdInput = card.querySelector('input[aria-label="模型名称（Model ID）"]')
  assert.equal(modelIdInput.value, 'deepseek-v4-flash')
  const inputTokenField = card.querySelector('input[aria-label="最大输入 token"]')
  const outputTokenField = card.querySelector('input[aria-label="最大输出 token"]')
  assert.equal(inputTokenField.value, '', '两个 token 上限保持未知，必须由用户手动填写')
  assert.equal(outputTokenField.value, '', '两个 token 上限保持未知，必须由用户手动填写')
  assert.equal(harness.configureCalls.length, 0, '预填建议不得自动写入配置')
})

test('SEM-F36/J25: 首次配置按连接→密钥→模型确认→测试与默认用途推进，预设详情可展开且密钥不留在 UI', async (t) => {
  const presets = publicPresetCatalog()
  const presetResponse = {
    contractId: 'agent-model-presets-ui', contractVersion: '1.0.0', presets
  }
  assertGetPresetsResponse(presetResponse)
  const configureResponse = { contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: true, revision: 1, error: null }
  assertConfigureResponse(configureResponse)
  const harness = await createHarness({
    catalogResponses: [fixture(0)],
    configureResponses: [configureResponse],
    presets: presetResponse,
    testSavedAgentModel: (request) => {
      const response = {
        contractId: 'agent-model-test-ui', contractVersion: '1.0.0', testId: request.testId,
        ok: true, status: 'success', nextAction: 'none'
      }
      assertTestRequest(request)
      assertTestResponse(response)
      return response
    }
  })
  t.after(() => harness.dispose())

  assert.equal(harness.presetCalls.length, 1)
  assert.equal(harness.presetCalls[0], undefined, 'renderer 通过 preload 的无参方法读取预设，contract header 由 preload 补齐')
  assert.equal(document.querySelector('[data-wizard-step="connection"]') !== null, true)
  assert.match(document.querySelector('.wizard-details summary').textContent, /查看预设详情/)
  assert.match(document.querySelector('[data-wizard-step="connection"]').textContent, /deepseek-v4-flash/)

  await act(async () => click(findButton(document, '保存连接并继续')))
  await flush()
  assert.equal(document.querySelector('[data-wizard-step="credential"]') !== null, true)
  assert.equal(harness.configureCalls[0].command.type, 'createProfile')
  assert.equal(harness.configureCalls[0].command.profileId, 'preset.deepseek-openai')

  const credentialInput = document.querySelector('input[aria-label="首次配置 API 密钥"]')
  await act(async () => typeInto(credentialInput, 'sk-wizard-secret'))
  await flush()
  await act(async () => click(findButton(document, '保存 API 密钥并继续')))
  await flush()
  assert.equal(document.querySelector('input[aria-label="首次配置 API 密钥"]'), null, '进入下一步后密钥输入框应卸载')
  assert.equal(document.body.innerHTML.includes('sk-wizard-secret'), false, '首配提交后密钥不得留在 DOM')
  assert.equal(harness.configureCalls[1].command.type, 'setCredential')

  await act(async () => click(findButton(document, '确认并保存模型')))
  await flush()
  assert.equal(document.querySelector('[data-wizard-step="test"]') !== null, true)
  assert.equal(harness.configureCalls[2].command.type, 'addModel')
  assert.equal(harness.configureCalls[2].command.modelId, 'deepseek-v4-flash')
  assert.equal(document.querySelector('[data-wizard-step="test"]').textContent.includes('跳过测试并设置默认用途'), true)

  await act(async () => click(findButton(document, '测试模型')))
  await flush()
  assert.equal(harness.testCalls.length, 1)
  assert.equal(harness.testCalls[0].profileId, 'preset.deepseek-openai')
  assert.equal(harness.testCalls[0].modelId, 'deepseek-v4-flash')
  assert.equal(Object.prototype.hasOwnProperty.call(harness.testCalls[0], 'credential'), false)
  assert.match(document.querySelector('[data-wizard-step="test"]').textContent, /模型测试成功/)

  await act(async () => click(findButton(document, '设置为默认模型')))
  await flush()
  assert.equal(harness.configureCalls[3].command.type, 'assignPurpose')
  assert.deepEqual(harness.configureCalls.map(({ command }) => command.type), ['createProfile', 'setCredential', 'addModel', 'assignPurpose'])
  assert.equal(document.querySelector('.agent-model-wizard'), null)
  await act(async () => click(findButton(document, '使用服务预设快速配置')))
  await flush()
  assert.equal(document.querySelector('[data-wizard-step="connection"]') !== null, true, '已有页面仍可主动重新打开预设向导')
})

test('SEM-F36/J25: reopened wizard resumes from the authoritative saved model stage', async (t) => {
  const saved = fixture(1)
  saved.snapshot.profiles[0].profileId = 'preset.deepseek-openai'
  saved.snapshot.readinessByPurpose.default.target.profileId = 'preset.deepseek-openai'
  const presets = publicPresetCatalog()
  const harness = await createHarness({
    catalogResponses: [saved],
    presets: { contractId: 'agent-model-presets-ui', contractVersion: '1.0.0', presets }
  })
  t.after(() => harness.dispose())
  await act(async () => click(findButton(document, '使用服务预设快速配置')))
  await flush()
  assert.equal(document.querySelector('[data-wizard-step="test"]') !== null, true)
  assert.equal(document.querySelector('[data-wizard-step="connection"]'), null)
  assert.equal(document.querySelector('[data-wizard-step="credential"]'), null)
})

test('SEM-F36/J25: provider terminal result wins over a late renderer cancellation acknowledgement', async (t) => {
  const response = {
    contractId: 'agent-model-test-ui', contractVersion: '1.0.0',
    testId: 'test.race', ok: true, status: 'success', nextAction: 'none'
  }
  const pending = deferred()
  const harness = await createHarness({
    catalogResponses: [fixture(1)],
    testSavedAgentModel: () => pending.promise,
    cancelSavedAgentModel: async () => ({ ok: false, status: 'cancelled', nextAction: 'none' })
  })
  t.after(() => harness.dispose())
  const card = document.querySelector('[data-profile-id="deepseek"]')
  await act(async () => click(findButton(card, '测试模型')))
  await flush()
  const cancel = findButton(card, '取消测试')
  assert.ok(cancel)
  await act(async () => click(cancel))
  await flush()
  assert.ok(findButton(card, '正在取消测试'))
  pending.resolve(response)
  await flush()
  assert.match(card.textContent, /模型测试成功/)
  assert.doesNotMatch(card.textContent, /模型测试已取消/)
})

test('S5-UX/J25(S2 Core 子边界): 模板删除后不重建，呈现空态', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(3)] })
  t.after(() => harness.dispose())

  const list = document.querySelector('.agent-model-profiles')
  assert.match(list.textContent, /还没有服务配置/)
  assert.doesNotMatch(list.textContent, /模板|重建|deepseek/i)
})

test('S5-UX/J25(S2 Core 子边界): 四个模型用途分别呈现 direct/fallback_default 与三值 readiness', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(1)] })
  t.after(() => harness.dispose())

  const defaultRow = document.querySelector('[data-purpose="default"]')
  assert.match(defaultRow.textContent, /已单独配置/)
  assert.match(defaultRow.textContent, /DeepSeek/)
  assert.match(defaultRow.textContent, /普通请求：配置充分/)
  assert.match(defaultRow.textContent, /Agent Loop：配置充分/)
  const defaultSummary = document.querySelector('.agent-model-default-summary')
  assert.match(defaultSummary.textContent, /DeepSeek · deepseek-v4-flash/)
  assert.ok(defaultSummary.compareDocumentPosition(document.querySelector('.agent-model-profiles')) &
    defaultSummary.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    '已有配置先展示默认模型摘要，再进入服务管理')

  const summaryRow = document.querySelector('[data-purpose="summary"]')
  assert.match(summaryRow.textContent, /回落到默认/)
  assert.equal(document.querySelector('.purpose-details').open, false, '专用用途默认折叠，默认用途保持可见')
})

test('S5-UX/J25(S2 Core 子边界): supportsToolCalling=false 的模型使 Agent Loop 呈现「未配置可用的模型」', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(2)] })
  t.after(() => harness.dispose())

  const defaultRow = document.querySelector('[data-purpose="default"]')
  assert.match(defaultRow.textContent, /普通请求：配置充分/)
  assert.match(defaultRow.textContent, /Agent Loop：未配置可用的模型/)
})

test('SEM-F33/J25: usageReporting=false explains unknown usage and comparison limitation', async () => {
  const viewModel = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-model-view-model.ts'))
  const text = viewModel.capabilitySummary({
    maxInputTokens: 1000, maxOutputTokens: 100, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: true, usageReporting: false
  })
  assert.match(text, /用量上报：不支持（交互不会显示 token，也无法参与用量比较）/)
})

test('S5-UX/J25(S2 Core 子边界): session_only 凭据文案，且提交凭据后不残留明文', async (t) => {
  const harness = await createHarness({
    catalogResponses: [fixture(2)],
    configureResponses: [{ contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: true, revision: 5, error: null }]
  })
  t.after(() => harness.dispose())

  const card = document.querySelector('[data-profile-id="gateway"]')
  assert.match(card.textContent, /仅本次运行有效/)

  const credentialInput = card.querySelector('input[type="password"]')
  await act(async () => typeInto(credentialInput, 'sk-super-secret-value'))
  await flush()
  assert.equal(credentialInput.value, 'sk-super-secret-value')

  await act(async () => click(findButton(card, '设置新的 API 密钥')))
  await flush()
  assert.equal(credentialInput.value, '', '提交后必须立即清空，凭据不得残留在组件状态中')
  assert.equal(document.body.innerHTML.includes('sk-super-secret-value'), false, '凭据明文不得进入 DOM')
  assert.equal(harness.configureCalls[0].command.type, 'setCredential')
})

test('S5-UX/J25(S2 Core 子边界): MODEL_CONFIG_INVALID 保留用户输入且零写入', async (t) => {
  const invalidResponse = {
    contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: false, revision: null,
    error: { code: 'MODEL_CONFIG_INVALID', nextAction: 'correct_input' }
  }
  assertConfigureResponse(invalidResponse)
  const harness = await createHarness({ catalogResponses: [fixture(1)], configureResponses: [invalidResponse] })
  t.after(() => harness.dispose())

  const nameInput = document.querySelector('input[aria-label="新服务名称"]')
  const originInput = document.querySelector('input[aria-label="新服务 API 服务器地址"]')
  const basePathInput = document.querySelector('input[aria-label="新服务 API 基础路径"]')
  await act(async () => {
    typeInto(nameInput, '公司网关')
    typeInto(originInput, 'https://gw.example.com')
    typeInto(basePathInput, '/v1')
  })
  await flush()

  // 中文名称推导不出合法档案标识，字段自动展开为必填空值，需手动填写
  const profileIdInput = document.querySelector('input[aria-label="配置标识"]')
  assert.notEqual(profileIdInput, null, '推导失败时档案标识字段必须自动展开')
  await act(async () => typeInto(profileIdInput, 'company-gateway'))
  await flush()

  const createButton = findButton(document, '添加模型服务')
  assert.equal(createButton.disabled, false)
  await act(async () => click(createButton))
  await flush()

  assert.equal(harness.configureCalls.length, 1)
  assert.equal(harness.configureCalls[0].command.type, 'createProfile')
  assert.equal(nameInput.value, '公司网关', '输入无效时必须保留用户输入')
  assert.equal(document.querySelector('[role="alert"]').textContent, '输入无效，本次没有写入任何内容。')
  assert.equal(document.querySelectorAll('[data-profile-id]').length, 1, '零写入：档案列表不应新增')
})

test('SEM-F36/J25: renderer refuses reserved preset profile ids for custom services', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(1)] })
  t.after(() => harness.dispose())
  await act(async () => {
    typeInto(document.querySelector('input[aria-label="新服务名称"]'), '公司网关')
    typeInto(document.querySelector('input[aria-label="新服务 API 服务器地址"]'), 'https://gw.example.com')
    typeInto(document.querySelector('input[aria-label="配置标识"]'), 'preset.deepseek-openai')
  })
  await flush()
  assert.equal(findButton(document, '添加模型服务').disabled, true)
  assert.match(document.querySelector('.agent-model-new-profile').textContent, /服务预设保留/)
  assert.equal(harness.configureCalls.length, 0)
})

test('SEM-F36/J25: auto-derived reserved preset ids expand the correction field', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(3)] })
  t.after(() => harness.dispose())

  await act(async () => typeInto(document.querySelector('input[aria-label="新服务名称"]'), 'Company Gateway'))
  await flush()
  assert.equal(document.querySelector('input[aria-label="配置标识"]'), null,
    '普通合法自动标识在没有冲突时应保持高级字段折叠')

  await act(async () => typeInto(document.querySelector('input[aria-label="新服务名称"]'), 'preset.deepseek-openai'))
  await flush()

  assert.notEqual(document.querySelector('input[aria-label="配置标识"]'), null,
    '自动推导出保留命名空间时必须展开配置标识字段')
  assert.match(document.querySelector('.agent-model-new-profile').textContent, /自动推导的标识不可用，请手动填写/)
  assert.equal(findButton(document, '添加模型服务').disabled, true)
  assert.equal(harness.configureCalls.length, 0)
})

test('S5-UX/J25(S2 Core 子边界): MODEL_CONFIG_REVISION_CONFLICT 保留输入并自动收敛到权威 catalog', async (t) => {
  const conflictResponse = {
    contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: false, revision: null,
    error: { code: 'MODEL_CONFIG_REVISION_CONFLICT', nextAction: 'reload' }
  }
  assertConfigureResponse(conflictResponse)
  const authoritative = fixture(2)
  const harness = await createHarness({ catalogResponses: [fixture(1)], configureResponses: [conflictResponse] })
  t.after(() => harness.dispose())

  const nameInput = document.querySelector('input[aria-label="新服务名称"]')
  await act(async () => {
    typeInto(nameInput, '公司网关')
    typeInto(document.querySelector('input[aria-label="新服务 API 服务器地址"]'), 'https://gw.example.com')
  })
  await flush()

  // 中文名称推导不出合法档案标识，字段自动展开为必填空值，需手动填写
  await act(async () => typeInto(document.querySelector('input[aria-label="配置标识"]'), 'company-gateway'))
  await flush()

  harness.pushCatalog(authoritative)
  await act(async () => click(findButton(document, '添加模型服务')))
  await flush()

  assert.equal(nameInput.value, '公司网关', '冲突后仍保留用户输入')
  assert.equal(document.querySelector('[role="alert"]').textContent,
    '配置已在别处更新，本次没有写入。已重新载入权威配置，你的输入仍保留。')
  assert.notEqual(document.querySelector('[data-profile-id="gateway"]'), null, '冲突后必须收敛到权威 catalog')
})

test('S5-UX/J25(S2 Core 子边界): 远端目录建议覆盖六值状态，success 不自动落库', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(1)] })
  t.after(() => harness.dispose())
  const card = document.querySelector('[data-profile-id="deepseek"]')
  const pullButton = findButton(card, '从服务器获取模型建议')

  const cases = [
    [8, '已获取模型建议'],
    [9, '配置已在别处更新，请重新载入后再试'],
    [10, '请求无效，未获取建议'],
    [11, '缺少 API 密钥，无法获取建议'],
    [12, '服务器返回了不受信任的跳转，已拒绝'],
    [13, '暂时无法连接服务器']
  ]
  for (const [index, expectedText] of cases) {
    harness.pushPull(fixture(index))
    await act(async () => click(pullButton))
    await flush()
    assert.equal(card.textContent.includes(expectedText), true, `缺少状态文案: ${expectedText}`)
  }
  assert.equal(harness.configureCalls.length, 0, 'remote pull 建议不应自动写入配置')
})

test('S5-UX/J25(S2 Core 子边界): 删除档案与删除 model 的确认层写出作用对象', async (t) => {
  const harness = await createHarness({
    catalogResponses: [fixture(1)],
    configureResponses: [{ contractId: 'agent-model-ui', contractVersion: '1.0.0', ok: true, revision: 4, error: null }]
  })
  t.after(() => harness.dispose())
  const card = document.querySelector('[data-profile-id="deepseek"]')

  await act(async () => click(findButton(card, '删除')))
  await flush()
  assert.equal(card.textContent.includes('这个模型不再可选；指向它的模型用途会变成未配置。'), true)

  await act(async () => click(findButton(card, '取消')))
  await flush()

  await act(async () => click(findButton(card, '删除服务配置')))
  await flush()
  assert.equal(card.textContent.includes(
    '这份服务配置、它的模型列表和 API 密钥都会移除；使用它的模型用途会变成未配置；已经开始的运行保留原有模型身份。'), true)
})

test('S5-UX/J25(S2 Core 子边界): model 六字段未全部作答时提交按钮保持禁用', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(1)] })
  t.after(() => harness.dispose())
  const card = document.querySelector('[data-profile-id="deepseek"]')

  await act(async () => click(findButton(card, '添加模型')))
  await flush()

  await act(async () => typeInto(card.querySelector('input[aria-label="模型名称（Model ID）"]'), 'model.two'))
  await flush()
  const saveButton = findButton(card, '保存模型')
  assert.equal(saveButton.disabled, true, '六字段未全部作答前必须禁用提交')

  await act(async () => {
    typeInto(card.querySelector('input[aria-label="最大输入 token"]'), '1000')
    typeInto(card.querySelector('input[aria-label="最大输出 token"]'), '500')
  })
  await flush()
  assert.equal(saveButton.disabled, true, '布尔字段仍未作答时必须继续禁用')

  for (const group of card.querySelectorAll('[role="radiogroup"]')) {
    const supportButton = [...group.querySelectorAll('button')].find((button) => button.textContent === '支持')
    await act(async () => click(supportButton))
  }
  await flush()
  assert.equal(saveButton.disabled, false, '六字段全部作答后应允许提交')
})

test('S5-UX/J25(S2 Core 子边界): 隐私负扫描 —— 不出现价格/费用字段、凭据明文、channel 名或本地路径', async (t) => {
  const harness = await createHarness({ catalogResponses: [fixture(1)] })
  t.after(() => harness.dispose())
  const text = document.body.textContent.toLowerCase()
  const html = document.body.innerHTML.toLowerCase()
  const forbidden = [
    '价格', '费用', '成本', '货币', 'price', 'cost', 'currency', 'pricing',
    'agent-model:get-catalog', 'agent-model:configure', 'agent-model:pull-remote-catalog', 'agent-model:changed',
    'c:\\', 'd:\\', '/home/', 'credential_slot_id'
  ]
  for (const term of forbidden) {
    assert.equal(text.includes(term.toLowerCase()), false, `不应在文本中出现: ${term}`)
    assert.equal(html.includes(term.toLowerCase()), false, `不应在 DOM 中出现: ${term}`)
  }
})
