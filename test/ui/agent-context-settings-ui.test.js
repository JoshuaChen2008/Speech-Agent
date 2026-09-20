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
const fixtureDir = path.join(root, 'src', 'agent', 'contracts', 'fixtures', 'agent-context-ui', 'v1.1.0')
const header = { contract_id: 'speech-agent.personal-context.ui', contract_version: '1.1.0' }

function readFixture (name) {
  return structuredClone(require(path.join(fixtureDir, name)))
}

async function flush () {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve))
  })
}

function click (element) { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }

function input (element, value) {
  const setter = Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLTextAreaElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function actionResponse (name, operation) {
  const response = readFixture(name).response
  if (response.result?.kind === 'memory_item') response.result.operation = operation
  return response
}

test('SEM-F30/SEM-F32/J21: settings consumes the exact personal-context UI contract for view, manage, reload and signal-safe controls', async (t) => {
  const { AgentContextPane } = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-context-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent
  })
  global.IS_REACT_ACT_ENVIRONMENT = true

  const overview = readFixture('overview-ready.json').response
  const memoryPage = readFixture('manage-view-ready.json').response
  const episodePage = readFixture('manage-view-episodes-ready.json').response
  episodePage.revision = 9
  const calls = []
  let deleteCount = 0
  let changedHandler = null
  const shell = {
    getAgentContextOverview: async (request) => { calls.push({ kind: 'overview', request }); return overview },
    onAgentContextChanged: (callback) => { changedHandler = callback; return () => { changedHandler = null } },
    manageAgentContext: async (request) => {
      calls.push({ kind: 'manage', request })
      const command = request.command
      if (command.type === 'view') return command.resource === 'session_episodes' ? episodePage : memoryPage
      if (command.type === 'remember') return readFixture('manage-remember-result.json').response
      if (command.type === 'update') return actionResponse('manage-remember-result.json', 'update')
      if (command.type === 'forget') return readFixture('manage-forget-result.json').response
      if (command.type === 'delete') {
        const response = readFixture('manage-delete-result.json').response
        response.result.replayed = deleteCount > 0
        deleteCount += 1
        return response
      }
      return readFixture('manage-set-processing-result.json').response
    }
  }

  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentContextPane, { shell })))
  await flush()
  t.after(async () => {
    await act(async () => reactRoot.unmount())
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    delete global.IS_REACT_ACT_ENVIRONMENT
  })

  assert.match(document.body.textContent, /个人记忆/)
  assert.match(document.body.textContent, /项目沟通偏好先给结论/)
  assert.equal(calls[0].kind, 'overview')
  assert.equal(calls[1].request.command.type, 'view')
  assert.equal(calls[1].request.command.resource, 'personal_memories')
  assert.equal(Object.hasOwn(calls[1].request.command, 'semantic_key'), false)

  const processingToggle = document.querySelector('input[aria-label="个人记忆自动处理"]')
  await act(async () => processingToggle.click())
  await flush()
  assert.equal(document.querySelector('[role="alertdialog"]').textContent.includes('Agent 也取不到个人记忆'), true)
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await flush()
  assert.equal(document.activeElement, processingToggle)
  await act(async () => processingToggle.click())
  await flush()
  await act(async () => click([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === '确认')))
  await flush()
  assert.equal(calls.some((entry) => entry.kind === 'manage' && entry.request.command.type === 'set_processing'), true)
  assert.equal(document.activeElement, processingToggle)

  const oversizedMemory = '界'.repeat(700)
  await act(async () => input(document.querySelector('textarea[aria-label="记住个人记忆"]'), oversizedMemory))
  await act(async () => click([...document.querySelectorAll('button')].find((button) => button.textContent === '记住')))
  await flush()
  assert.match(document.querySelector('[role="alert"]').textContent, /2048 个 UTF-8 字节/)
  assert.equal(document.querySelector('textarea[aria-label="记住个人记忆"]').value, oversizedMemory)

  await act(async () => input(document.querySelector('textarea[aria-label="记住个人记忆"]'), '项目代号使用北辰。'))
  await act(async () => click([...document.querySelectorAll('button')].find((button) => button.textContent === '记住')))
  await flush()
  const rememberCall = calls.find((entry) => entry.kind === 'manage' && entry.request.command.type === 'remember')
  assert.deepEqual(rememberCall.request.command.entry, {
    display_text: '项目代号使用北辰。', kind: 'term', scope: { kind: 'global', reference: null }
  })
  assert.equal(Object.hasOwn(rememberCall.request.command, 'semantic_key'), false)

  const item = document.querySelector('[data-memory-id]')
  await act(async () => click([...item.querySelectorAll('button')].find((button) => button.textContent === '修改')))
  await flush()
  await act(async () => input(item.querySelector('textarea[aria-label="修改个人记忆"]'), '项目沟通偏好先给结论并标注来源。'))
  await act(async () => click([...item.querySelectorAll('button')].find((button) => button.textContent === '保存修改')))
  await flush()
  assert.equal(calls.some((entry) => entry.kind === 'manage' && entry.request.command.type === 'update'), true)
  await act(async () => click([...item.querySelectorAll('button')].find((button) => button.textContent === '忘记')))
  await flush()
  await act(async () => click([...item.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === '确认')))
  await flush()
  assert.equal(calls.some((entry) => entry.kind === 'manage' && entry.request.command.type === 'forget'), true)
  await act(async () => click([...item.querySelectorAll('button')].find((button) => button.textContent === '删除')))
  await flush()
  await act(async () => click([...item.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === '确认')))
  await flush()
  assert.equal(calls.some((entry) => entry.kind === 'manage' && entry.request.command.type === 'delete'), true)
  assert.match(document.body.textContent, /条目 1、修改历史 3、来源引用 2/)
  const refreshedItem = document.querySelector('[data-memory-id]')
  await act(async () => click([...refreshedItem.querySelectorAll('button')].find((button) => button.textContent === '删除')))
  await flush()
  await act(async () => click([...refreshedItem.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === '确认')))
  await flush()
  assert.match(document.body.textContent, /本次没有产生新的删除；沿用首次计数：条目 1、修改历史 3、来源引用 2/)

  await act(async () => click([...document.querySelectorAll('[role="radio"]')].find((tab) => tab.textContent.includes('会话经历记录'))))
  await flush()
  assert.match(document.body.textContent, /合成会话摘要/)
  await act(async () => click([...document.querySelectorAll('[data-episode-id] button')].find((button) => button.textContent === '展开详情')))
  await flush()
  assert.match(document.body.textContent, /未提交尾部/)
  assert.equal(calls.some((entry) => entry.kind === 'manage' && entry.request.command.resource === 'session_episodes'), true)

  await act(async () => changedHandler({ contract_id: header.contract_id, contract_version: header.contract_version, revision: 99 }))
  await flush()
  assert.equal(calls.filter((entry) => entry.kind === 'overview').length >= 2, true)
})

test('SEM-T04/J21: personal-context settings surfaces revision conflict and keeps the product entry available', async (t) => {
  const { AgentContextPane } = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-context-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const overview = readFixture('overview-ready.json').response
  const page = readFixture('manage-view-ready.json').response
  const shell = {
    getAgentContextOverview: async () => overview,
    onAgentContextChanged: () => () => {},
    manageAgentContext: async (request) => request.command.type === 'view' ? page : readFixture('manage-revision-conflict.json').response
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentContextPane, { shell })))
  await flush()
  t.after(async () => {
    await act(async () => reactRoot.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    delete global.IS_REACT_ACT_ENVIRONMENT
  })
  await act(async () => input(document.querySelector('textarea[aria-label="记住个人记忆"]'), '冲突测试'))
  await act(async () => click([...document.querySelectorAll('button')].find((button) => button.textContent === '记住')))
  await flush()
  assert.match(document.body.textContent, /已在别处更新，本次未写入/)
  assert.equal(document.querySelector('textarea[aria-label="记住个人记忆"]').value, '冲突测试')
  assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent === '重新载入权威值'), true)
  assert.doesNotMatch(document.body.textContent, /stack|path|credential|prompt/i)
})

test('SEM-F30/J21: personal-context settings appends a bounded next page without losing the first page', async (t) => {
  const { AgentContextPane } = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-context-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const overview = readFixture('overview-ready.json').response
  const first = readFixture('manage-view-ready.json').response
  first.result.has_more = true; first.result.next_cursor = 'page2'
  const second = readFixture('manage-view-ready.json').response
  second.result.items[0].memory_id = 'memory.synthetic.002'
  second.result.items[0].display_text = '第二页个人记忆。'
  second.result.has_more = false; second.result.next_cursor = null
  const shell = {
    getAgentContextOverview: async () => overview,
    onAgentContextChanged: () => () => {},
    manageAgentContext: async (request) => request.command.cursor === null ? first : second
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentContextPane, { shell })))
  await flush()
  t.after(async () => {
    await act(async () => reactRoot.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    delete global.IS_REACT_ACT_ENVIRONMENT
  })
  assert.equal(document.querySelectorAll('[data-memory-id]').length, 1)
  await act(async () => click([...document.querySelectorAll('button')].find((button) => button.textContent === '读取更多')))
  await flush()
  assert.equal(document.querySelectorAll('[data-memory-id]').length, 2)
  assert.match(document.body.textContent, /第二页个人记忆/)
})

test('SEM-T04/J21: stale personal-context read failure cannot replace a newer successful resource read', async (t) => {
  const { AgentContextPane } = await loadRendererModule(path.join(root, 'src', 'settings', 'agent-context-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const overview = readFixture('overview-ready.json').response
  const episodes = readFixture('manage-view-episodes-ready.json').response
  let rejectMemory
  const shell = {
    getAgentContextOverview: async () => overview,
    onAgentContextChanged: () => () => {},
    manageAgentContext: async (request) => {
      if (request.command.type !== 'view') return readFixture('manage-set-processing-result.json').response
      if (request.command.resource === 'personal_memories') return new Promise((_resolve, reject) => { rejectMemory = reject })
      return episodes
    }
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentContextPane, { shell })))
  await flush()
  t.after(async () => {
    await act(async () => reactRoot.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    delete global.IS_REACT_ACT_ENVIRONMENT
  })
  await act(async () => click([...document.querySelectorAll('[role="radio"]')].find((tab) => tab.textContent.includes('会话经历记录'))))
  await flush()
  assert.match(document.body.textContent, /合成会话摘要/)
  await act(async () => rejectMemory(new Error('late read failure')))
  await flush()
  assert.doesNotMatch(document.body.textContent, /个人上下文暂时不可用|重试读取/)
  assert.equal(document.querySelectorAll('[data-episode-id]').length, 1)
})
