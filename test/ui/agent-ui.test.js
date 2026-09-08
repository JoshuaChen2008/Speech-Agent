'use strict'

require('./dom-bootstrap')

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('./load-renderer-module')

const root = path.resolve(__dirname, '..', '..')
const CONTRACT = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }

function source (relative) { return fs.readFileSync(path.join(root, relative), 'utf8') }
function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}
async function flush () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}
function click (element) { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }

async function createHarness () {
  const { AgentView } = await loadRendererModule(path.join(root, 'src', 'agent', 'agent-view.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://agent.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const changed = []
  const calls = []
  const submitRequests = []
  const cancelRequests = []
  const detailRequests = []
  const detailById = new Map()
  const detailDeferredById = new Map()
  const scope = { kind: 'session', reference: 'session.ui.1' }
  const scopeItem = { scope, display_name: 'loopback · 2026-09-08T10:00:00.000Z', started_at: '2026-09-08T09:59:00.000Z', ended_at: '2026-09-08T10:00:00.000Z', state: 'terminal' }
  const historyItem = { attempt_count: 1, created_at: 1, duration_ms: 42, error_code: null, interaction_id: 'interaction.ui.1', recipe_id: 'qa.answer', recipe_version: '1', result: { answer: '历史结果摘要' }, result_digest: 'a'.repeat(64), terminal_at: 2, terminal_reason: 'succeeded', usage: null, usage_state: 'unknown' }
  const historyItem2 = { attempt_count: 1, created_at: 2, duration_ms: 24, error_code: null, interaction_id: 'interaction.ui.2', recipe_id: 'summary.minutes', recipe_version: '1', result: { summary: '第二条历史结果' }, result_digest: 'b'.repeat(64), terminal_at: 3, terminal_reason: 'succeeded', usage: null, usage_state: 'unknown' }
  let currentDetail = { interaction_id: historyItem.interaction_id, run_id: 'run.ui.1', recipe_id: 'qa.answer', recipe_version: '1', routing_mode: 'model', state: 'running', terminal_reason: null, terminal_at: null, duration_ms: 42, created_at: 1, attempt_count: 1, error_code: null, result: { answer: '当前回答', sourceRefs: [] }, result_digest: null, source_refs: [], tool_calls: [], model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' }, usage: null, usage_state: 'unknown' }
  detailById.set(historyItem.interaction_id, currentDetail)
  detailById.set(historyItem2.interaction_id, { ...currentDetail, interaction_id: historyItem2.interaction_id, run_id: 'run.ui.2', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 3, result: { summary: '第二条历史结果' } })
  dom.window.ManualWindowDrag = { bindManualWindowDrag: () => ({ cancel () {} }), isInteractiveDragEvent: () => false }
  dom.window.agentApi = {
    dragStart () {}, dragEnd () {}, close () {}, onInteractionSync: () => () => {},
    subscribeChanged (callback) { changed.push(callback); calls.push('subscribe'); return () => {} },
    async getScopes (request) { calls.push(['scopes', request.cursor]); return { ok: true, scopes: request.cursor ? [] : [scopeItem], next_cursor: request.cursor ? null : 'scope.next', default_scope: request.cursor ? null : scope, revision: 1 } },
    async getHistory (request) { calls.push(['history', request.cursor]); return { ok: true, result: { items: request.cursor ? [] : [historyItem, historyItem2], has_more: false, next_cursor: request.cursor ? null : 'history.next' } } },
    async getEligibility (request) { calls.push(['eligibility', request.scope.reference]); return { ok: true, snapshot: { scope: request.scope, eligibility: 'ready', next_action: null, revision: 1 } } },
    async submit (request) { submitRequests.push(request); return { ok: true, result: { eligibility: 'ready', interaction_id: 'interaction.ui.3', recipe_id: 'qa.answer', revision: 2, routing_mode: 'model', run_id: 'run.ui.3', state: 'pending' } } },
    async cancel (request) { cancelRequests.push(request); return { ok: true, result: { interaction_id: request.interaction_id, revision: 3, state: 'cancelling' } } },
    async getInteraction (request) {
      detailRequests.push(request)
      const delayed = detailDeferredById.get(request.interaction_id)
      if (delayed) return delayed.promise
      const value = detailById.get(request.interaction_id) || { ...currentDetail, interaction_id: request.interaction_id, run_id: `run.${request.interaction_id}`, state: 'pending', terminal_reason: null, terminal_at: null }
      return { ok: true, result: value }
    }
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentView)))
  await flush()
  return {
    calls, changed, cancelRequests, detailRequests, dom, historyItem, submitRequests,
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    },
    setDetail (value) { currentDetail = value; detailById.set(value.interaction_id, value) },
    setDetailResponse (interactionId, pending) { detailDeferredById.set(interactionId, pending) }
  }
}

test('S5-UX/J22/J24: formal Agent renderer consumes the exact facade and keeps product language', () => {
  assert.match(source('src/agent/index.html'), /src="\.\/entry\.tsx"/)
  assert.match(source('src/agent/entry.tsx'), /createRoot[\s\S]*AgentView/)
  const view = source('src/agent/agent-view.tsx')
  for (const method of ['subscribeChanged', 'getScopes', 'getEligibility', 'submit', 'cancel', 'getHistory', 'getInteraction']) assert.match(view, new RegExp(`api\\.${method}`))
  assert.match(view, /生成纪要/)
  assert.match(view, /工具调用记录/)
  assert.match(view, /正在读取处理资格/)
  assert.doesNotMatch(view, /data-(?:scope|interaction)-id/)
  assert.doesNotMatch(`${source('src/agent/index.html')}\n${view}`, /<audio\b|reasoning|provider_event|apiKey|absolute_path/i)
})

test('S5-UX/J22: reload subscribes before reading, selects a terminal session, and submits without optimistic success', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  assert.equal(harness.calls[0], 'subscribe')
  assert.deepEqual(harness.calls.slice(1, 3).map((item) => item[0]), ['scopes', 'history'])
  assert.equal(document.querySelector('.scope-card').getAttribute('aria-current'), 'true')
  assert.equal(document.querySelector('.eligibility').textContent, '可以运行')

  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(harness.submitRequests.length, 1)
  assert.deepEqual(Object.keys(harness.submitRequests[0]).sort(), ['client_idempotency_key', 'contract_id', 'contract_version', 'prompt', 'scope'])
  assert.match(harness.submitRequests[0].prompt, /会后结构化纪要/)
  assert.equal(document.querySelector('.run-card strong').textContent, '等待执行', 'submit ACK is pending until the authoritative detail is read')
  assert.equal(document.body.textContent.includes('interaction.ui.2'), false)
})

test('S5-UX/J24: changed reload refreshes the selected detail and cancellation waits for a command result', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '执行中')
  await act(async () => click(document.querySelector('.run-card button')))
  await flush()
  assert.deepEqual(harness.cancelRequests[0], { ...CONTRACT, interaction_id: 'interaction.ui.1' })
  assert.equal(document.querySelector('.run-card strong').textContent, '执行中')
  harness.setDetail({ ...harness.historyItem, ...({ ...harness.historyItem, interaction_id: 'interaction.ui.1', run_id: 'run.ui.1', recipe_id: 'qa.answer', recipe_version: '1', routing_mode: 'model', state: 'cancelled', terminal_reason: 'cancelled', terminal_at: 3, duration_ms: 45, created_at: 1, attempt_count: 1, error_code: 'AGENT_CANCELLED', result: null, result_digest: null, source_refs: [], tool_calls: [], model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' }, usage: null, usage_state: 'unknown' }) })
  await act(async () => harness.changed[0]({ contract_id: CONTRACT.contract_id, contract_version: CONTRACT.contract_version, revision: 4 }))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已取消')
  assert.equal(harness.detailRequests.at(-1).interaction_id, 'interaction.ui.1')
})

test('S5-UX/J24: a late detail response cannot replace the newly selected interaction', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const delayed = deferred()
  harness.setDetailResponse('interaction.ui.1', delayed)
  const cards = document.querySelectorAll('.history-card')
  assert.equal(cards.length, 2)
  await act(async () => click(cards[0]))
  await flush()
  assert.equal(document.querySelector('.loading').textContent, '正在读取结果…')
  await act(async () => click(cards[1]))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已生成结果')
  delayed.resolve({ ok: true, result: { ...harness.historyItem, interaction_id: 'interaction.ui.1', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 4, result: { answer: '迟到结果' } } })
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已生成结果')
  assert.equal(document.body.textContent.includes('迟到结果'), false)
})

test('S5-UX/J22: list pagination only requests the list being extended', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const before = harness.calls.length
  await act(async () => click(document.querySelector('.scope-panel .more-button')))
  await flush()
  assert.deepEqual(harness.calls.slice(before), [['scopes', 'scope.next']])
})
