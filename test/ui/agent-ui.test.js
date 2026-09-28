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
const { deriveToolResultMetadata } = require('../../src/agent/contracts/controlled-tools')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const toolSourceRef = { sessionId:'session.ui', transcriptVersion:'raw', fromEventOrder:1, throughEventOrder:1 }
const toolArgs = { schemaVersion:1, sourceRefs:[toolSourceRef] }
const toolResult = { schemaVersion:1, sources:[{ sourceRef:toolSourceRef, text:'受控来源' }] }
const toolMetadata = deriveToolResultMetadata('read_sources', toolArgs, toolResult)
const toolCall = {
  args: toolArgs, args_digest: sha256Canonical(toolArgs), attempt:1, call_id:'call.ui.1', call_order:1,
  counts:{ resultBytes:toolMetadata.resultBytes, sourceTextBytes:toolMetadata.sourceTextBytes, sourceReferenceCount:toolMetadata.sourceReferenceCount },
  ended_offset_ms:12, error_code:null, result:toolResult, result_digest:toolMetadata.resultDigest, schema_version:1,
  source_refs:toolMetadata.sourceRefs, started_offset_ms:0, status:'succeeded', tool_name:'read_sources'
}

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
function input (element, value) {
  const setter = Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLTextAreaElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function createHarness (options = {}) {
  const { AgentView } = await loadRendererModule(path.join(root, 'src', 'agent', 'agent-view.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://agent.test/' })
  const intervals = new Map()
  let nextIntervalId = 0
  let visibilityState = 'visible'
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibilityState })
  dom.window.setInterval = (callback, milliseconds) => {
    const id = ++nextIntervalId
    intervals.set(id, { callback, milliseconds })
    return id
  }
  dom.window.clearInterval = (id) => intervals.delete(id)
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event', 'MouseEvent'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  global.IS_REACT_ACT_ENVIRONMENT = true
  const changed = []
  const configChanged = []
  const summaryChanged = []
  const calls = []
  let closeRequests = 0
  const submitRequests = []
  const summarySnapshots = new Map()
  const summarySnapshotByKey = new Map()
  const summaryCancelRequests = []
  const summaryDiagnosticsQueries = []
  const summaryDiagnosticsExports = []
  const resumeRequests = []
  let recoverableSummaryQueries = 0
  let summaryRequestSequence = 0
  const cancelRequests = []
  const exportRequests = []
  const signalRequests = []
  const detailRequests = []
  const detailById = new Map()
  const detailDeferredById = new Map()
  const scope = { kind: 'session', reference: 'session.ui.1' }
  const scopeItem = { scope, display_name: 'loopback · 2026-09-08T10:00:00.000Z', started_at: '2026-09-08T09:59:00.000Z', ended_at: '2026-09-08T10:00:00.000Z', state: 'terminal' }
  const comparisonGroupId = 'c'.repeat(64)
  const historyItem = { attempt_count: 1, comparison_group_id: comparisonGroupId, created_at: 1, duration_ms: 42, error_code: null, interaction_id: 'interaction.ui.1', model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' }, recipe_id: 'qa.answer', recipe_version: '1', result: { answer: '历史结果摘要' }, result_digest: 'a'.repeat(64), terminal_at: 2, terminal_reason: 'succeeded', usage: { input_tokens: 100, output_tokens: 20, usage_source: 'provider', cache_hit_input_tokens: 40, cache_miss_input_tokens: 60 }, usage_state: 'known' }
  const historyItem2 = { attempt_count: 1, comparison_group_id: comparisonGroupId, created_at: 2, duration_ms: 24, error_code: null, interaction_id: 'interaction.ui.2', model: { adapter_id: 'adapter.internal', model_id: 'model.alt', profile_id: 'profile.alt', profile_revision: 2, provider_kind: 'cloud' }, recipe_id: 'summary.minutes', recipe_version: '1', result: { summary: '第二条历史结果' }, result_digest: 'b'.repeat(64), terminal_at: 3, terminal_reason: 'succeeded', usage: { input_tokens: 80, output_tokens: 10, usage_source: 'provider', cache_hit_input_tokens: null, cache_miss_input_tokens: null }, usage_state: 'known' }
  const historyItems = options.historyItems || [historyItem, historyItem2]
  let currentDetail = { interaction_id: historyItem.interaction_id, run_id: 'run.ui.1', recipe_id: 'qa.answer', recipe_version: '1', routing_mode: 'model', state: 'running', terminal_reason: null, terminal_at: null, duration_ms: 42, created_at: 1, attempt_count: 1, error_code: null, result: { answer: '当前回答', sourceRefs: [] }, result_digest: null, source_refs: [], tool_calls: [toolCall], model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' }, usage: null, usage_state: 'unknown' }
  detailById.set(historyItem.interaction_id, currentDetail)
  detailById.set(historyItem2.interaction_id, { ...currentDetail, interaction_id: historyItem2.interaction_id, run_id: 'run.ui.2', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 3, result: { summary: '第二条历史结果' } })
  dom.window.ManualWindowDrag = { bindManualWindowDrag: () => ({ cancel () {} }), isInteractiveDragEvent: () => false }
  dom.window.agentApi = {
    dragStart () {}, dragEnd () {}, close () { closeRequests += 1 }, onInteractionSync: () => () => {},
    getConfig: options.getConfig || (async () => ({ agentEnabled: true, memoryEnabled: true, summaryUseMemory: true })),
    onConfig (callback) { configChanged.push(callback); calls.push('config'); return () => {} },
    subscribeChanged (callback) { changed.push(callback); calls.push('subscribe'); return () => {} },
    onSessionSummaryRunChanged (callback) { summaryChanged.push(callback); return () => {} },
    async getScopes (request) {
      calls.push(['scopes', request.cursor])
      if (options.getScopes) return options.getScopes(request, { scope, scopeItem })
      return { ok: true, scopes: request.cursor ? [] : [scopeItem], next_cursor: request.cursor ? null : 'scope.next', default_scope: request.cursor ? null : scope, revision: 1 }
    },
    async getHistory (request) {
      calls.push(['history', request.cursor])
      if (options.getHistory) return options.getHistory(request, { historyItems })
      return { ok: true, result: { items: request.cursor ? [] : historyItems, has_more: false, next_cursor: request.cursor ? null : 'history.next' } }
    },
    async getEligibility (request) {
      calls.push(['eligibility', request.scope.reference])
      if (options.getEligibility) return options.getEligibility(request)
      return { ok: true, snapshot: { scope: request.scope, eligibility: 'ready', next_action: null, revision: 1 } }
    },
    async acceptSessionSummaryRun (request) {
      submitRequests.push(request)
      if (options.submit) return options.submit(request)
      let snapshot = summarySnapshotByKey.get(request.client_request_key)
      const replayed = !!snapshot
      if (!snapshot) {
        summaryRequestSequence += 1
        const id = `request.summary.ui.${summaryRequestSequence}`
        const summary = request.action === 'summary'
        snapshot = {
          request_id: id, generation: 1, revision: 0, action: request.action,
          state: 'queued', phase: 'accepted', attempt: 0, elapsed_ms: 0,
          last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
          memory_state: 'not_read', error_code: null, budget: null, freshness: 'fresh',
          cancel_requested: false, resume_required: false, diagnostics_available: true,
          route_run_id: null, target_run_id: `run.ui.${summaryRequestSequence + 2}`,
          interaction_id: 'interaction.ui.3', recipe_id: summary ? 'summary.minutes' : 'qa.answer',
          routing_mode: summary ? 'preset' : 'model'
        }
        summarySnapshotByKey.set(request.client_request_key, snapshot)
        summarySnapshots.set(id, snapshot)
        if (request.resubmits_request_id && Array.isArray(options.recoverableSummaryRuns)) {
          options.recoverableSummaryRuns = options.recoverableSummaryRuns.filter(
            (item) => item.snapshot.request_id !== request.resubmits_request_id
          )
        }
        const event = { contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0', request_id: id, generation: 1, revision: 0 }
        for (const listener of summaryChanged) listener(event)
      }
      return { ok: true, result: { accepted: true, replayed, snapshot } }
    },
    async getSessionSummaryRun (request) {
      if (options.getSessionSummaryRun) return options.getSessionSummaryRun(request)
      const snapshot = summarySnapshots.get(request.request_id)
      return snapshot ? { ok: true, result: { snapshot } } : { ok: false, error: { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' }, result: null }
    },
    async getSessionSummaryRunDiagnostics (request) {
      summaryDiagnosticsQueries.push(request)
      if (options.getSessionSummaryRunDiagnostics) return options.getSessionSummaryRunDiagnostics(request)
      return {
        ok: true, error: null,
        result: {
          available: true,
          records: [{
            schemaVersion: 1, appVersion: '0.1.0', requestDigest: 'a'.repeat(64), runDigest: null,
            attempt: 1, sequence: 2, phase: 'waiting_model', event: 'model_request_started',
            elapsedMs: 420, lastActivityAgeMs: 0, errorCode: null, budgetAxis: null,
            metrics: { actual: null, limit: null, unit: null }, modelBindingDigest: null, planDigest: null
          }],
          next_before_sequence: null
        }
      }
    },
    async exportSessionSummaryRunDiagnostics (request) {
      summaryDiagnosticsExports.push(request)
      if (options.exportSessionSummaryRunDiagnostics) return options.exportSessionSummaryRunDiagnostics(request)
      return { ok: true, error: null, result: { status: 'cancelled', record_count: 0, available: true } }
    },
    async cancelSessionSummaryRun (request) {
      summaryCancelRequests.push(request)
      if (options.cancelSessionSummaryRun) return options.cancelSessionSummaryRun(request)
      const snapshot = summarySnapshots.get(request.request_id)
      const cancelled = { ...snapshot, revision: snapshot.revision + 1, state: 'cancelling', phase: 'cancelling', cancel_requested: true }
      summarySnapshots.set(request.request_id, cancelled)
      return { ok: true, result: { snapshot: cancelled } }
    },
    async listRecoverableSessionSummaryRuns (request) {
      recoverableSummaryQueries += 1
      if (options.listRecoverableSessionSummaryRuns) return options.listRecoverableSessionSummaryRuns(request)
      const requests = options.recoverableSummaryRuns || []
      for (const item of requests) summarySnapshots.set(item.snapshot.request_id, item.snapshot)
      return { ok: true, error: null, result: { requests } }
    },
    async resumeSessionSummaryRun (request) {
      resumeRequests.push(request)
      if (options.resumeSessionSummaryRun) return options.resumeSessionSummaryRun(request)
      const prior = (options.recoverableSummaryRuns || []).find((item) => item.snapshot.request_id === request.request_id)?.snapshot
      const resumed = {
        ...(prior || summarySnapshots.get(request.request_id)),
        generation: request.generation + 1,
        revision: request.expected_revision + 1,
        state: 'queued', phase: 'accepted', resume_required: false
      }
      summarySnapshots.set(request.request_id, resumed)
      if (Array.isArray(options.recoverableSummaryRuns)) {
        options.recoverableSummaryRuns = options.recoverableSummaryRuns.filter((item) => item.snapshot.request_id !== request.request_id)
      }
      return { ok: true, error: null, result: { snapshot: resumed } }
    },
    async cancel (request) {
      cancelRequests.push(request)
      if (options.cancel) return options.cancel(request)
      return { ok: true, result: { interaction_id: request.interaction_id, revision: 3, state: 'cancelling' } }
    },
    async getInteraction (request) {
      detailRequests.push(request)
      if (options.getInteraction) return options.getInteraction(request, { currentDetail, detailById })
      const delayed = detailDeferredById.get(request.interaction_id)
      if (delayed) return delayed.promise
      const value = detailById.get(request.interaction_id) || { ...currentDetail, interaction_id: request.interaction_id, run_id: `run.${request.interaction_id}`, state: 'pending', terminal_reason: null, terminal_at: null }
      return { ok: true, result: value }
    },
    async exportInteraction (request) {
      exportRequests.push(request)
      if (options.exportInteraction) return options.exportInteraction(request)
      return { ok: true, error: null, result: { bytes_sha256: 'c'.repeat(64), interaction_id: request.interaction_id, schema_version: 1, snapshot: {} } }
    },
    async recordSignal (request) {
      signalRequests.push(request)
      if (options.recordSignal) return options.recordSignal(request)
      return { ok: true, error: null, result: { accepted: true, interaction_id: request.interaction_id, replayed: false, signal_kind: request.signal_kind } }
    }
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(AgentView)))
  await flush()
  return {
    calls, changed, configChanged, cancelRequests, detailRequests, dom, exportRequests, historyItem, scopeItem, signalRequests, submitRequests, summaryCancelRequests, summaryDiagnosticsExports, summaryDiagnosticsQueries, summaryChanged, summarySnapshots, resumeRequests, closeRequests: () => closeRequests,
    recoverableSummaryQueries: () => recoverableSummaryQueries,
    activeIntervals: () => intervals.size,
    async tickIntervals (milliseconds) {
      const callbacks = [...intervals.values()].filter((interval) => interval.milliseconds === milliseconds).map((interval) => interval.callback)
      await act(async () => {
        for (const callback of callbacks) callback()
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))
      })
    },
    async setVisibility (value) {
      visibilityState = value
      await act(async () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')))
      await flush()
    },
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
  for (const method of ['subscribeChanged', 'getConfig', 'onConfig', 'getScopes', 'getEligibility', 'acceptSessionSummaryRun', 'getSessionSummaryRun', 'cancelSessionSummaryRun', 'resumeSessionSummaryRun', 'listRecoverableSessionSummaryRuns', 'onSessionSummaryRunChanged', 'cancel', 'getHistory', 'getInteraction', 'exportInteraction', 'recordSignal']) assert.match(view, new RegExp(`api\\.${method}`))
  assert.match(source('src/preload/agent.js'), /getConfig:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(CHANNELS\.CONFIG_GET\)/)
  assert.match(source('src/preload/agent.js'), /onConfig:\s*\(callback\)\s*=>\s*subscribe\(CHANNELS\.CONFIG_CHANGED, callback\)/)
  assert.match(view, /生成总结/)
  assert.match(view, /详细信息/)
  for (const signal of ['提交修改', '有帮助', '不准确', '记住其中一条', '不再使用']) assert.match(view, new RegExp(signal))
  assert.match(view, /正在读取处理资格/)
  assert.doesNotMatch(view, /data-(?:scope|interaction)-id/)
  assert.doesNotMatch(`${source('src/agent/index.html')}\n${view}`, /<audio\b|reasoning|provider_event|apiKey|absolute_path/i)
})

test('SEM-F38/J29: beginner copy states the actual summary memory policy and keeps QA wording separate', async (t) => {
  const withMemory = await createHarness({
    getConfig: async () => ({ agentEnabled: true, memoryEnabled: true, summaryUseMemory: true })
  })
  assert.match(document.querySelector('.memory-policy-hint').textContent, /本次生成会参考相关记忆/)
  assert.match(document.querySelector('.memory-policy-hint').textContent, /会话问答会按记忆设置使用信息/)
  await withMemory.dispose()

  const withoutMemory = await createHarness({
    getConfig: async () => ({ agentEnabled: true, memoryEnabled: true, summaryUseMemory: false })
  })
  t.after(() => withoutMemory.dispose())
  assert.match(document.querySelector('.memory-policy-hint').textContent, /本次生成只依据这场会话/)
})

test('SEM-F38/SEM-T04/J30-RECOVERY: reopening shows a frozen summary scope and only continues after an explicit click', async (t) => {
  const scope = { kind: 'session', reference: 'session.ui.recovered' }
  const snapshot = {
    request_id: 'request.ui.recovered', generation: 1, revision: 4, action: 'summary',
    state: 'retry_wait', phase: 'retry_wait', attempt: 2, elapsed_ms: 1200,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'unknown', error_code: null, budget: null, freshness: 'fresh',
    cancel_requested: false, resume_required: true, diagnostics_available: false,
    route_run_id: null, target_run_id: 'run.ui.recovered', interaction_id: 'interaction.ui.recovered',
    recipe_id: 'summary.minutes', routing_mode: 'preset'
  }
  const harness = await createHarness({ recoverableSummaryRuns: [{ scope, snapshot }] })
  t.after(() => harness.dispose())
  assert.equal(harness.recoverableSummaryQueries() >= 1, true)
  assert.match(document.querySelector('.recoverable-runs').textContent, /需要处理的请求/)
  assert.match(document.querySelector('.recoverable-runs').textContent, /诊断记录不可用/)
  assert.match(document.querySelector('.recoverable-runs').textContent, /继续生成/)
  assert.equal(harness.resumeRequests.length, 0)

  await act(async () => click([...document.querySelectorAll('.recoverable-runs button')].find((button) => button.textContent === '继续生成')))
  await flush()
  assert.equal(harness.resumeRequests.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.resumeRequests[0])), {
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.ui.recovered', generation: 1, expected_revision: 4
  })
  assert.equal(document.querySelector('[aria-label="当前会话总结请求状态"] strong').textContent, '等待处理')
  assert.equal(document.querySelector('.recoverable-runs'), null)
  await act(async () => click(document.querySelector('[aria-label="关闭会话总结"]')))
  assert.equal(harness.closeRequests(), 1)
  assert.equal(harness.summaryCancelRequests.length, 0)
})

test('SEM-F38/SEM-T04/J30-RECOVERY: a lost question is left empty and can be submitted again', async (t) => {
  const scope = { kind: 'session', reference: 'session.ui.question-recovered' }
  const snapshot = {
    request_id: 'request.ui.question-recovered', generation: 1, revision: 3, action: 'question',
    state: 'failed', phase: 'terminal', attempt: 1, elapsed_ms: 800,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'not_read', error_code: 'AGENT_REQUEST_INVALID', budget: null, freshness: 'fresh',
    cancel_requested: false, resume_required: true, diagnostics_available: false,
    route_run_id: null, target_run_id: null, interaction_id: null, recipe_id: null, routing_mode: null
  }
  const harness = await createHarness({ recoverableSummaryRuns: [{ scope, snapshot }] })
  t.after(() => harness.dispose())
  const prompt = document.querySelector('#agentPrompt')
  assert.equal(prompt.value, '')
  assert.equal(prompt.disabled, false)
  assert.equal([...document.querySelectorAll('.scope-card')].every((button) => button.disabled), true)
  assert.match(document.body.textContent, /问题内容未保留/)
  await act(async () => input(prompt, '请重新说明主要决定'))
  await act(async () => click(document.querySelector('[data-action="qa"]')))
  await flush()
  assert.equal(harness.submitRequests.at(-1).action, 'question')
  assert.equal(harness.submitRequests.at(-1).prompt, '请重新说明主要决定')
  assert.equal(harness.submitRequests.at(-1).resubmits_request_id, 'request.ui.question-recovered')
  assert.notEqual(harness.submitRequests.at(-1).client_request_key, 'request.ui.question-recovered')
  assert.equal(document.querySelector('.recoverable-runs'), null)
})

test('SEM-F38/J29: an open Agent Bar refreshes summary policy copy after settings change', async (t) => {
  const harness = await createHarness({
    getConfig: async () => ({ agentEnabled: true, memoryEnabled: true, summaryUseMemory: true, agentSettingsRevision: 1 })
  }); t.after(() => harness.dispose())
  assert.equal(harness.configChanged.length, 1)
  assert.match(document.querySelector('.memory-policy-hint').textContent, /本次生成会参考相关记忆/)
  await act(async () => harness.configChanged[0]({ agentEnabled: true, memoryEnabled: true, summaryUseMemory: false, agentSettingsRevision: 2 }))
  await flush()
  assert.match(document.querySelector('.memory-policy-hint').textContent, /本次生成只依据这场会话/)
  await act(async () => harness.configChanged[0]({ agentEnabled: false, memoryEnabled: true, summaryUseMemory: true, agentSettingsRevision: 3 }))
  await flush()
  assert.match(document.querySelector('.memory-policy-hint').textContent, /本次生成只依据这场会话/)
})

test('SEM-F38/J30-CANCEL: an accepted pending receipt keeps cancellation available when the first detail read fails', async (t) => {
  const harness = await createHarness({
    getInteraction: async () => ({ ok: false, error: { category: 'unavailable', code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' } })
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '等待处理')
  assert.equal(document.querySelector('.scope-card').disabled, true)
  assert.equal(document.querySelector('.run-card button').disabled, false)
  await act(async () => click(document.querySelector('.run-card button')))
  await flush()
  assert.equal(harness.summaryCancelRequests.length, 1)
  assert.equal(harness.summaryCancelRequests[0].request_id, [...harness.summarySnapshots.keys()][0])
  assert.equal(harness.summaryCancelRequests[0].generation, 1)
  assert.equal(document.querySelector('.run-card strong').textContent, '正在取消')
})

test('SEM-F38/J30-CANCEL: a terminal cancel receipt remains visible and stops polling when detail reads fail', async (t) => {
  let detailReadCount = 0
  const harness = await createHarness({
    cancel: async (request) => ({ ok: true, result: { interaction_id: request.interaction_id, revision: 4, state: 'failed' } }),
    getInteraction: async (request, { detailById }) => {
      detailReadCount += 1
      if (detailReadCount === 1) return { ok: true, result: detailById.get(request.interaction_id) }
      return { ok: false, error: { category: 'unavailable', code: 'AGENT_UNAVAILABLE', next_action: 'retry' } }
    }
  }); t.after(() => harness.dispose())

  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '正在生成')
  assert.equal(harness.activeIntervals(), 1)

  await act(async () => click(document.querySelector('.run-card button')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '生成失败')
  assert.equal(document.querySelector('.run-card button').disabled, true)
  assert.equal(document.querySelector('.result-card'), null, 'an old active detail is cleared until a terminal detail can be read')
  assert.ok(document.querySelector('.request-panel [role="alert"]'), 'the detail read failure is visible')
  assert.equal(document.body.textContent.includes('AGENT_UNAVAILABLE'), false)
  assert.equal(document.body.textContent.includes('AGENT_PROVIDER_TIMEOUT'), false, 'do not infer a failure cause from the terminal state alone')
  assert.equal(harness.activeIntervals(), 0, 'a terminal cancel receipt stops detail polling')
})

test('SEM-F38/J30-CANCEL: a stale running detail cannot replace a terminal cancel receipt', async (t) => {
  let detailReadCount = 0
  const harness = await createHarness({
    cancel: async (request) => ({ ok: true, result: { interaction_id: request.interaction_id, revision: 4, state: 'cancelled' } }),
    getInteraction: async (request, { detailById }) => {
      detailReadCount += 1
      return { ok: true, result: detailById.get(request.interaction_id) }
    }
  }); t.after(() => harness.dispose())

  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  await act(async () => click(document.querySelector('.run-card button')))
  await flush()

  assert.ok(detailReadCount >= 2, 'a post-cancel detail read was attempted')
  assert.equal(document.querySelector('.run-card strong').textContent, '已取消')
  assert.equal(document.querySelector('.run-card button').disabled, true)
  assert.equal(document.querySelector('.result-card'), null)
  assert.match(document.querySelector('.request-panel [role="alert"]').textContent, /交互详情暂时不可用/)
  assert.equal(harness.activeIntervals(), 0)
})

test('SEM-F38/J30-STATE: a terminal history state stops polling when its first detail read fails', async (t) => {
  const harness = await createHarness({
    historyItems: [{ ...harnessHistoryItem('interaction.ui.terminal', 3), terminal_reason: 'failed', error_code: 'AGENT_PROVIDER_TIMEOUT' }],
    getInteraction: async () => ({ ok: false, error: { category: 'unavailable', code: 'AGENT_UNAVAILABLE', next_action: 'retry' } })
  }); t.after(() => harness.dispose())

  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '生成失败')
  assert.ok(document.querySelector('.request-panel [role="alert"]'))
  assert.equal(harness.activeIntervals(), 0, 'known terminal history does not start a poll loop without a detail')
})

test('S5-UX/J22: reload subscribes before reading, selects a terminal session, and submits without optimistic success', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  assert.equal(harness.calls[0], 'subscribe')
  assert.deepEqual(harness.calls.slice(1, 3).map((item) => item[0]), ['scopes', 'history'])
  assert.equal(document.querySelector('.scope-card').getAttribute('aria-current'), 'true')
  assert.equal(document.querySelector('.eligibility').textContent, '配置已就绪，提交后检查输入容量')

  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(harness.submitRequests.length, 1)
  assert.deepEqual(Object.keys(harness.submitRequests[0]).sort(), ['action', 'client_request_key', 'contract_id', 'contract_version', 'scope'])
  assert.equal(harness.submitRequests[0].action, 'summary')
  const snapshot = [...harness.summarySnapshots.values()][0]
  assert.equal(snapshot.routing_mode, 'preset')
  assert.equal(snapshot.route_run_id, null)
  assert.equal(document.querySelector('.run-card strong').textContent, '等待处理', 'the accepted request does not claim a completed result')
  assert.equal(document.body.textContent.includes('interaction.ui.2'), false)
})

test('SEM-F40/J30-DIAG: active summary shows when diagnostic records are unavailable', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(document.body.textContent.includes('诊断记录不可用'), false)

  const [requestId, snapshot] = [...harness.summarySnapshots.entries()][0]
  const unavailable = { ...snapshot, revision: snapshot.revision + 1, diagnostics_available: false }
  harness.summarySnapshots.set(requestId, unavailable)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: requestId, generation: unavailable.generation, revision: unavailable.revision
  }))
  await flush()
  assert.equal(document.querySelector('[aria-label="当前会话总结请求状态"]').textContent.includes('诊断记录不可用'), true)
})

test('SEM-F40/J30-DIAG: active summary can inspect diagnostics and cancelled export stays silent', async (t) => {
  const diagnosticRecord = (sequence, event, phase) => ({
    schemaVersion: 1, appVersion: '0.1.0', requestDigest: 'a'.repeat(64), runDigest: null,
    attempt: 1, sequence, phase, event, elapsedMs: sequence * 210, lastActivityAgeMs: 0,
    errorCode: null, budgetAxis: null, metrics: { actual: null, limit: null, unit: null },
    modelBindingDigest: null, planDigest: null
  })
  const harness = await createHarness({
    getSessionSummaryRunDiagnostics: async (request) => ({
      ok: true, error: null,
      result: {
        available: true,
        records: request.before_sequence === null
          ? [diagnosticRecord(3, 'model_request_started', 'waiting_model')]
          : [diagnosticRecord(1, 'accepted', 'accepted')],
        next_before_sequence: request.before_sequence === null ? 3 : null
      }
    })
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  const [requestId] = [...harness.summarySnapshots.keys()]
  await act(async () => click(document.querySelector('.diagnostics-panel summary')))
  await act(async () => click([...document.querySelectorAll('.diagnostics-panel button')].find((button) => button.textContent === '查看诊断')))
  await flush()

  assert.equal(harness.summaryDiagnosticsQueries.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(harness.summaryDiagnosticsQueries[0])), {
    contract_id: 'speech-agent.agent-run-diagnostics.ui',
    contract_version: '1.0.0',
    request_id: requestId,
    before_sequence: null,
    limit: 50
  })
  assert.match(document.querySelector('[aria-label="诊断记录"]').textContent, /模型请求已发送/)
  assert.equal(document.querySelector('.diagnostics-panel').textContent.includes('读取更早记录'), true)
  await act(async () => click([...document.querySelectorAll('.diagnostics-panel button')].find((button) => button.textContent === '读取更早记录')))
  await flush()
  assert.equal(harness.summaryDiagnosticsQueries.length, 2)
  assert.equal(harness.summaryDiagnosticsQueries[1].before_sequence, 3)
  assert.equal(document.querySelector('[aria-label="诊断记录"] ol').children.length, 2)
  const statusBeforeCancelledExport = document.querySelector('.agent-titlebar .status').textContent
  await act(async () => click([...document.querySelectorAll('.diagnostics-panel button')].find((button) => button.textContent === '导出诊断')))
  await flush()
  assert.equal(harness.summaryDiagnosticsExports.length, 1)
  assert.equal(harness.summaryDiagnosticsExports[0].request_id, requestId)
  assert.equal(document.querySelector('.agent-titlebar .status').textContent, statusBeforeCancelledExport)
  assert.equal(document.body.textContent.includes('已导出'), false)
})

test('SEM-F40/J30-DIAG: a changed recoverable request refreshes its diagnostic availability', async (t) => {
  const scope = { kind: 'session', reference: 'session.ui.diagnostics-recoverable' }
  const snapshot = {
    request_id: 'request.ui.diagnostics-recoverable', generation: 1, revision: 2, action: 'summary',
    state: 'retry_wait', phase: 'retry_wait', attempt: 1, elapsed_ms: 1200,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'unknown', error_code: null, budget: null, freshness: 'fresh',
    cancel_requested: false, resume_required: true, diagnostics_available: true,
    route_run_id: null, target_run_id: 'run.ui.diagnostics-recoverable', interaction_id: 'interaction.ui.diagnostics-recoverable',
    recipe_id: 'summary.minutes', routing_mode: 'preset'
  }
  const recoverableSummaryRuns = [{ scope, snapshot }]
  const harness = await createHarness({ recoverableSummaryRuns }); t.after(() => harness.dispose())
  assert.equal(document.querySelector('.recoverable-runs').textContent.includes('诊断记录不可用'), false)

  const unavailable = { ...snapshot, revision: snapshot.revision + 1, diagnostics_available: false }
  recoverableSummaryRuns[0] = { scope, snapshot: unavailable }
  harness.summarySnapshots.set(snapshot.request_id, unavailable)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: snapshot.request_id, generation: snapshot.generation, revision: unavailable.revision
  }))
  await flush()
  assert.match(document.querySelector('.recoverable-runs').textContent, /诊断记录不可用/)
  assert.equal(harness.recoverableSummaryQueries() >= 2, true)
})

test('SEM-F38/J30-STATE/J31-SIZE: visible polling replaces stale running state with the terminal capacity failure', async (t) => {
  const originalNow = Date.now
  let now = 1000
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let unavailable = false
  let latestDetail = null
  const harness = await createHarness({
    getInteraction: async (request, { detailById }) => {
      if (unavailable) return { ok: false, error: { category: 'unavailable', code: 'AGENT_UNAVAILABLE', next_action: 'retry' } }
      return { ok: true, result: latestDetail || detailById.get(request.interaction_id) }
    }
  })
  t.after(() => harness.dispose())

  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '正在生成')
  assert.equal(harness.activeIntervals(), 1)
  const beforePoll = harness.detailRequests.length

  now = 12000
  unavailable = true
  await harness.tickIntervals(2000)
  assert.equal(harness.detailRequests.length, beforePoll + 1)
  assert.equal(document.querySelector('.run-card strong').textContent, '状态暂时无法确认')
  assert.equal(document.querySelector('.stale-status').textContent, '上次确认状态：正在生成；正在重新读取。')
  assert.equal(harness.activeIntervals(), 1)

  latestDetail = {
    ...harness.historyItem,
    interaction_id: 'interaction.ui.1', run_id: 'run.ui.1', recipe_id: 'summary.minutes', recipe_version: '1',
    state: 'failed', terminal_reason: 'failed', terminal_at: 4, duration_ms: 0,
    error_code: 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', result: null, result_digest: null, summary_use_memory: true,
    memory_reference_count: 0, source_refs: [], tool_calls: []
  }
  unavailable = false
  await harness.tickIntervals(2000)

  assert.equal(document.querySelector('.run-card strong').textContent, '生成失败')
  assert.equal(document.querySelector('.result-card header strong').textContent, '生成失败')
  assert.equal(document.querySelector('.result-card small').textContent.includes('0 ms'), true)
  assert.match(document.querySelector('.result-card [role="alert"]').textContent, /会话总结输入超过当前上限；总结模型尚未调用/)
  assert.match(document.querySelector('.result-card .empty').textContent, /缩短输入，或选择内容较少的会话后重试/)
  assert.match(document.querySelector('.result-card footer').textContent, /尚未读取记忆/)
  assert.equal(document.querySelector('.run-card button').disabled, true)
  assert.equal(harness.activeIntervals(), 0, 'terminal detail stops polling')
})

test('SEM-F38/J30-STATE: resuming a hidden window immediately rereads the selected interaction', async (t) => {
  let latestDetail = null
  const harness = await createHarness({
    getInteraction: async (request, { detailById }) => ({ ok: true, result: latestDetail || detailById.get(request.interaction_id) })
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  const beforeHide = harness.detailRequests.length
  await harness.setVisibility('hidden')
  assert.equal(harness.activeIntervals(), 0)
  latestDetail = {
    ...harness.historyItem,
    interaction_id: 'interaction.ui.1', run_id: 'run.ui.1', recipe_id: 'qa.answer', recipe_version: '1',
    state: 'failed', terminal_reason: 'failed', terminal_at: 4, error_code: 'AGENT_PROVIDER_TIMEOUT',
    result: null, result_digest: null, source_refs: [], tool_calls: []
  }
  await harness.setVisibility('visible')
  assert.equal(harness.detailRequests.length, beforeHide + 1)
  assert.equal(document.querySelector('.run-card strong').textContent, '生成失败')
  assert.equal(harness.activeIntervals(), 0)
})

test('SEM-F38/J29: successful memory retry keeps its references visible when another read failed', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  harness.setDetail({
    ...harness.historyItem2, interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', recipe_id: 'summary.minutes',
    state: 'succeeded', terminal_reason: 'succeeded', summary_use_memory: true, memory_reference_count: 1,
    tool_calls: [
      { ...toolCall, tool_name: 'search_context', status: 'failed', error_code: 'TOOL_TIMEOUT', call_id: 'call.ui.failed' },
      { ...toolCall, tool_name: 'search_context', status: 'succeeded', error_code: null, call_id: 'call.ui.succeeded' }
    ]
  })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.match(document.querySelector('.result-card footer').textContent, /已参考 1 条记忆；另一次读取失败/)
})

test('SEM-F38/J31-SIZE: generic budget failures do not claim oversized transcript or zero model calls', async (t) => {
  let latestDetail = null
  const harness = await createHarness({
    getInteraction: async (request, { detailById }) => ({ ok: true, result: latestDetail || detailById.get(request.interaction_id) })
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  latestDetail = {
    ...harness.historyItem, interaction_id: 'interaction.ui.1', run_id: 'run.ui.1', recipe_id: 'summary.minutes',
    state: 'failed', terminal_reason: 'failed', terminal_at: 4, error_code: 'AGENT_BUDGET_EXCEEDED', result: null
  }
  await harness.tickIntervals(2000)
  const message = document.querySelector('.result-card [role="alert"]').textContent
  assert.match(message, /已达到预算限制/)
  assert.equal(message.includes('总结模型尚未调用'), false)
  assert.match(document.querySelector('.result-card .empty').textContent, /请重试/)
})

test('S5-UX/J25: history groups sibling interactions and exposes model, usage, cache rate, and relative duration', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())

  assert.match(document.querySelector('.history-list').textContent, /profile\.internal \/ model\.internal/)
  assert.match(document.querySelector('.history-list').textContent, /profile\.alt \/ model\.alt/)
  const comparison = document.querySelector('.comparison-card')
  assert.ok(comparison)
  assert.match(comparison.textContent, /同一会话与问题的不同模型结果/)
  assert.match(comparison.textContent, /输入 100 · 输出 20 · 来源 provider · 缓存命中率 40\.0%/)
  assert.match(comparison.textContent, /相对时长 1\.75×/)
  assert.match(comparison.textContent, /缓存命中率未知/)
})

test('S5-UX/J25: history does not call repeated runs of one frozen model a model comparison', async (t) => {
  const model = { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 3, provider_kind: 'cloud' }
  const comparisonGroupId = 'd'.repeat(64)
  const harness = await createHarness({ historyItems: [
    { ...harnessHistoryItem('interaction.ui.same.1', 1), comparison_group_id: comparisonGroupId, model },
    { ...harnessHistoryItem('interaction.ui.same.2', 2), comparison_group_id: comparisonGroupId, model }
  ] }); t.after(() => harness.dispose())

  assert.equal(document.querySelector('.comparison-card'), null)
})

function harnessHistoryItem (interactionId, createdAt) {
  return { attempt_count: 1, created_at: createdAt, duration_ms: 24, error_code: null, interaction_id: interactionId, recipe_id: 'qa.answer', recipe_version: '1', result: { answer: '同模型结果' }, result_digest: String(createdAt).repeat(64), terminal_at: createdAt + 1, terminal_reason: 'succeeded', usage: null, usage_state: 'unknown' }
}

test('S5-UX/J24: changed reload refreshes the selected detail and cancellation waits for a command result', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '正在生成')
  await act(async () => click(document.querySelector('.run-card button')))
  await flush()
  assert.deepEqual(harness.cancelRequests[0], { ...CONTRACT, interaction_id: 'interaction.ui.1' })
  assert.equal(document.querySelector('.run-card strong').textContent, '正在生成')
  harness.setDetail({ ...harness.historyItem, ...({ ...harness.historyItem, interaction_id: 'interaction.ui.1', run_id: 'run.ui.1', recipe_id: 'qa.answer', recipe_version: '1', routing_mode: 'model', state: 'cancelled', terminal_reason: 'cancelled', terminal_at: 3, duration_ms: 45, created_at: 1, attempt_count: 1, error_code: 'AGENT_CANCELLED', result: null, result_digest: null, source_refs: [], tool_calls: [], model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' }, usage: null, usage_state: 'unknown' }) })
  await act(async () => harness.changed[0]({ contract_id: CONTRACT.contract_id, contract_version: CONTRACT.contract_version, revision: 4 }))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已取消')
  assert.equal(harness.detailRequests.at(-1).interaction_id, 'interaction.ui.1')
})

test('S5-UX/J24: stale changed revisions do not trigger a second reload', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const before = harness.calls.length
  await act(async () => harness.changed[0]({ contract_id: CONTRACT.contract_id, contract_version: CONTRACT.contract_version, revision: 1 }))
  await flush()
  assert.equal(harness.calls.length, before)
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
  assert.equal(document.querySelector('.run-card strong').textContent, '已生成')
  delayed.resolve({ ok: true, result: { ...harness.historyItem, interaction_id: 'interaction.ui.1', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 4, result: { answer: '迟到结果' } } })
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已生成')
  assert.equal(document.body.textContent.includes('迟到结果'), false)
})

test('S5-UX/J22: list pagination only requests the list being extended', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const before = harness.calls.length
  await act(async () => click(document.querySelector('.scope-panel .more-button')))
  await flush()
  assert.deepEqual(harness.calls.slice(before), [['scopes', 'scope.next']])
})

test('SEM-F31/J22: manual refresh rereads unchanged scope eligibility and disables submit while pending', async (t) => {
  const pending = deferred()
  let reads = 0
  const harness = await createHarness({
    getEligibility: async (request) => {
      reads += 1
      if (reads === 1) return { ok: true, snapshot: { scope: request.scope, eligibility: 'ready', next_action: null, revision: 1 } }
      return pending.promise
    }
  }); t.after(() => harness.dispose())
  const refresh = document.querySelector('.scope-panel .panel-heading button')
  await act(async () => click(refresh))
  await flush()
  assert.equal(reads, 2)
  assert.equal(document.querySelector('[data-action="minutes"]').disabled, true)
  pending.resolve({ ok: true, snapshot: { scope: { kind: 'session', reference: 'session.ui.1' }, eligibility: 'ready', next_action: null, revision: 2 } })
  await flush()
  assert.equal(document.querySelector('[data-action="minutes"]').disabled, false)
})

test('SEM-F31/J24: a higher changed revision rereads unchanged scope eligibility', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const before = harness.calls.filter((item) => Array.isArray(item) && item[0] === 'eligibility').length
  await act(async () => harness.changed[0]({ ...CONTRACT, revision: 4 }))
  await flush()
  const after = harness.calls.filter((item) => Array.isArray(item) && item[0] === 'eligibility').length
  assert.equal(after, before + 1)
})

test('SEM-F31/J22: an older eligibility response cannot replace a newer refresh result', async (t) => {
  const oldRead = deferred()
  let reads = 0
  const harness = await createHarness({
    getEligibility: async (request) => {
      reads += 1
      if (reads === 1) return oldRead.promise
      return { ok: true, snapshot: { scope: request.scope, eligibility: 'ready', next_action: null, revision: 2 } }
    }
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.scope-panel .panel-heading button')))
  await flush()
  assert.equal(document.querySelector('.eligibility').textContent, '配置已就绪，提交后检查输入容量')
  oldRead.resolve({ ok: true, snapshot: { scope: { kind: 'session', reference: 'session.ui.1' }, eligibility: 'provider_not_configured', next_action: null, revision: 1 } })
  await flush()
  assert.equal(document.querySelector('.eligibility').textContent, '配置已就绪，提交后检查输入容量')
})

test('SEM-F31/J22: scope and history pagination complete independently and deduplicate stable identities', async (t) => {
  const scopePage = deferred()
  const historyPage = deferred()
  const harness = await createHarness({
    getScopes: async (request, values) => request.cursor ? scopePage.promise : { ok: true, scopes: [values.scopeItem], next_cursor: 'scope.next', default_scope: values.scope, revision: 1 },
    getHistory: async (request, values) => request.cursor ? historyPage.promise : { ok: true, result: { items: values.historyItems, has_more: true, next_cursor: 'history.next' } }
  }); t.after(() => harness.dispose())
  const scopeMore = document.querySelector('.scope-panel .more-button')
  const historyMore = document.querySelector('.history-panel .more-button')
  await act(async () => { click(scopeMore); click(historyMore) })
  await flush()
  scopePage.resolve({ ok: true, scopes: [harness.scopeItem, { ...harness.scopeItem, scope: { kind: 'session', reference: 'session.ui.2' }, display_name: '第二场终态会话' }], next_cursor: null, default_scope: null, revision: 2 })
  await flush()
  assert.equal(document.querySelector('.scope-panel').textContent.includes('正在读取…'), false)
  assert.equal(document.querySelector('.history-panel').textContent.includes('正在读取…'), true)
  historyPage.resolve({ ok: true, result: { items: [harness.historyItem, { ...harness.historyItem, interaction_id: 'interaction.ui.3', run_id: 'run.ui.3' }], has_more: false, next_cursor: null } })
  await flush()
  assert.equal(document.querySelectorAll('.scope-card').length, 2)
  assert.equal(document.querySelectorAll('.history-card').length, 3)
  assert.equal(document.querySelector('.scope-panel').textContent.includes('正在读取…'), false)
  assert.equal(document.querySelector('.history-panel').textContent.includes('正在读取…'), false)
})

test('SEM-F31/J24: a full revision refresh invalidates both older pagination responses', async (t) => {
  const scopePage = deferred()
  const historyPage = deferred()
  const harness = await createHarness({
    getScopes: async (request, values) => request.cursor ? scopePage.promise : { ok: true, scopes: [values.scopeItem], next_cursor: 'scope.next', default_scope: values.scope, revision: request.cursor ? 1 : 5 },
    getHistory: async (request, values) => request.cursor ? historyPage.promise : { ok: true, result: { items: values.historyItems, has_more: true, next_cursor: 'history.next' } }
  }); t.after(() => harness.dispose())
  await act(async () => {
    click(document.querySelector('.scope-panel .more-button'))
    click(document.querySelector('.history-panel .more-button'))
  })
  await act(async () => harness.changed[0]({ ...CONTRACT, revision: 6 }))
  await flush()
  scopePage.resolve({ ok: true, scopes: [{ ...harness.scopeItem, scope: { kind: 'session', reference: 'session.ui.stale' }, display_name: '过期范围' }], next_cursor: null, default_scope: null, revision: 2 })
  historyPage.resolve({ ok: true, result: { items: [{ ...harness.historyItem, interaction_id: 'interaction.ui.stale' }], has_more: false, next_cursor: null } })
  await flush()
  assert.equal(document.body.textContent.includes('过期范围'), false)
  assert.equal(document.querySelectorAll('.history-card').length, 2)
  assert.equal(document.querySelector('.scope-panel').textContent.includes('正在读取…'), false)
  assert.equal(document.querySelector('.history-panel').textContent.includes('正在读取…'), false)
})

test('SEM-F31/F32/J21/J24: detail refresh preserves the edit draft and drafts follow interaction identity', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const succeeded = (item, answer) => ({
    ...item, interaction_id: item.interaction_id, run_id: `run.${item.interaction_id}`, routing_mode: 'model', state: 'succeeded',
    terminal_reason: 'succeeded', result: { answer }, source_refs: [], tool_calls: [], model: item.model
  })
  harness.setDetail(succeeded(harness.historyItem, '第一条结果'))
  harness.setDetail(succeeded({ ...harness.historyItem, interaction_id: 'interaction.ui.2', result_digest: 'b'.repeat(64) }, '第二条结果'))
  await act(async () => click(document.querySelectorAll('.history-card')[0]))
  await flush()
  await act(async () => input(document.querySelector('#agentEdit'), '第一条编辑草稿'))
  await act(async () => harness.changed[0]({ ...CONTRACT, revision: 4 }))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value, '第一条编辑草稿')

  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  await act(async () => input(document.querySelector('#agentEdit'), '第二条编辑草稿'))
  await act(async () => click(document.querySelectorAll('.history-card')[0]))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value, '第一条编辑草稿')
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value, '第二条编辑草稿')
})

test('SEM-F32/J21: at most twenty non-empty interaction drafts are retained without silent eviction', async (t) => {
  const items = Array.from({ length: 21 }, (_, index) => ({ ...harnessHistoryItem(`interaction.ui.draft.${index + 1}`, index + 1), result_digest: `${index + 1}`.padEnd(64, '0') }))
  const harness = await createHarness({
    historyItems: items,
    getInteraction: async (request) => {
      const item = items.find((candidate) => candidate.interaction_id === request.interaction_id)
      return { ok: true, result: { ...item, run_id: `run.${item.interaction_id}`, routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', result: { answer: '合成结果' }, source_refs: [], tool_calls: [], model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' } } }
    }
  }); t.after(() => harness.dispose())
  const cards = document.querySelectorAll('.history-card')
  for (let index = 0; index < 20; index += 1) {
    await act(async () => click(cards[index]))
    await flush()
    await act(async () => input(document.querySelector('#agentEdit'), `草稿 ${index + 1}`))
  }
  await act(async () => click(cards[20]))
  await flush()
  const editor = document.querySelector('#agentEdit')
  assert.equal(editor.maxLength, 4096)
  await act(async () => input(editor, '第 21 条草稿'))
  assert.equal(editor.value, '')
  assert.match(document.body.textContent, /最多保留 20 条非空草稿/)
  await act(async () => click(cards[0]))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value, '草稿 1')
  await act(async () => input(document.querySelector('#agentEdit'), '甲'.repeat(4097)))
  assert.equal(document.querySelector('#agentEdit').value.length, 4096)
  await act(async () => click(cards[1]))
  await flush()
  await act(async () => click(cards[0]))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value.length, 4096)
})

test('SEM-F31/J24/J26: late feedback and export receipts do not update a newly selected interaction', async (t) => {
  const signal = deferred()
  const exported = deferred()
  const harness = await createHarness({ recordSignal: async () => signal.promise, exportInteraction: async () => exported.promise }); t.after(() => harness.dispose())
  harness.setDetail({ ...harness.historyItem, run_id: 'run.ui.1', routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', source_refs: [], tool_calls: [] })
  harness.setDetail({ ...harness.historyItem, interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', result_digest: 'b'.repeat(64), routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', source_refs: [], tool_calls: [] })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  await act(async () => click(document.querySelector('[data-signal="accept"]')))
  await act(async () => click([...document.querySelectorAll('button')].find((item) => item.textContent === '导出结果 JSON')))
  await act(async () => click(document.querySelectorAll('.history-card')[0]))
  await flush()
  signal.resolve({ ok: true, error: null, result: { accepted: true, interaction_id: 'interaction.ui.2', replayed: false, signal_kind: 'accept' } })
  exported.resolve({ ok: true, error: null, result: { bytes_sha256: 'c'.repeat(64), interaction_id: 'interaction.ui.2', schema_version: 1, snapshot: {} } })
  await flush()
  assert.equal(document.body.textContent.includes('已记录交互反馈'), false)
  assert.equal(document.body.textContent.includes('已导出交互 JSON'), false)
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.equal(document.body.textContent.includes('已记录交互反馈'), true)
  assert.equal(document.querySelector('.status').textContent.includes('已导出交互 JSON'), true)
})

test('SEM-F31/J24: a late cancellation receipt remains attached to its original interaction', async (t) => {
  const cancelled = deferred()
  const harness = await createHarness({ cancel: async () => cancelled.promise }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  await act(async () => click([...document.querySelectorAll('button')].find((item) => item.textContent === '导出结果 JSON')))
  await flush()
  assert.equal(document.querySelector('.status').textContent, '已导出交互 JSON')
  const secondDetail = deferred()
  harness.setDetailResponse('interaction.ui.2', secondDetail)
  await act(async () => click(document.querySelectorAll('.history-card')[0]))
  await flush()
  await act(async () => click(document.querySelector('.run-card button')))
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  cancelled.resolve({ ok: true, result: { interaction_id: 'interaction.ui.1', revision: 4, state: 'cancelling' } })
  await flush()
  secondDetail.resolve({ ok: true, result: { ...harness.historyItem, interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', result_digest: 'b'.repeat(64), routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', source_refs: [], tool_calls: [] } })
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '已生成')
  assert.equal(document.querySelector('.status').textContent, '已导出交互 JSON')
})

test('SEM-F38/J30-ACCEPT/J22: an unknown acceptance response retains input and reuses its request key only for the same payload', async (t) => {
  const first = deferred()
  let attempt = 0
  const harness = await createHarness({
    submit: async () => {
      attempt += 1
      if (attempt === 1) return first.promise
      throw new Error('SECRET choose_supported_recipe')
    }
  }); t.after(() => harness.dispose())
  const prompt = document.querySelector('#agentPrompt')
  await act(async () => input(prompt, '原始问题'))
  const submit = document.querySelector('[data-action="qa"]')
  await act(async () => { click(submit); click(submit) })
  assert.equal(harness.submitRequests.length, 1)
  first.resolve({ ok: false, error: { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' }, result: null })
  await flush()
  assert.equal(prompt.value, '原始问题')
  assert.equal(prompt.disabled, true)
  assert.equal(document.querySelector('.scope-card').disabled, true)
  assert.equal(document.body.textContent.includes('SECRET'), false)
  assert.equal(document.body.textContent.includes('choose_supported_recipe'), false)
  await act(async () => harness.changed[0]({ revision: 4 }))
  await flush()
  assert.equal(prompt.disabled, true)
  assert.equal(document.querySelector('.scope-card').disabled, true)

  const retry = document.querySelector('[aria-label="受理状态未确认"] button')
  assert.ok(retry)
  await act(async () => click(retry))
  await flush()
  assert.equal(harness.submitRequests.length, 2)
  assert.equal(harness.submitRequests[1].client_request_key, harness.submitRequests[0].client_request_key)
  assert.deepEqual(harness.submitRequests[1].scope, harness.submitRequests[0].scope)
  assert.equal(harness.submitRequests[1].prompt, harness.submitRequests[0].prompt)
})

test('SEM-F38/J30-ACCEPT: an explicit settings refusal releases the pinned request for correction', async (t) => {
  const harness = await createHarness({
    submit: async () => ({ ok: false, error: { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'settings' }, result: null })
  }); t.after(() => harness.dispose())
  const prompt = document.querySelector('#agentPrompt')
  await act(async () => input(prompt, '原始问题'))
  await act(async () => click(document.querySelector('[data-action="qa"]')))
  await flush()
  assert.equal(document.querySelector('[aria-label="受理状态未确认"]'), null)
  assert.equal(prompt.disabled, false)
  assert.equal(document.querySelector('.scope-card').disabled, false)
  assert.match(document.querySelector('.status').textContent, /请在设置中完成所需配置/)
})

test('SEM-F38/J30-ACCEPT: refresh preserves the submitted session when it is absent from the first scope page', async (t) => {
  let scopeReads = 0
  const harness = await createHarness({
    getScopes: async (request, values) => {
      if (request.cursor) return { ok: true, scopes: [], next_cursor: null, default_scope: null, revision: ++scopeReads }
      scopeReads += 1
      const second = {
        ...values.scopeItem,
        scope: { kind: 'session', reference: 'session.ui.2' },
        display_name: '第二场已结束会话'
      }
      return {
        ok: true,
        scopes: scopeReads === 1 ? [values.scopeItem, second] : [values.scopeItem],
        next_cursor: null,
        default_scope: values.scope,
        revision: scopeReads
      }
    }
  }); t.after(() => harness.dispose())

  await act(async () => click(document.querySelectorAll('.scope-card')[1]))
  await flush()
  assert.match(document.querySelector('.selected-scope').textContent, /第二场已结束会话/)
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(harness.submitRequests[0].scope.reference, 'session.ui.2')
  assert.equal(document.querySelectorAll('.scope-card').length, 1)
  assert.match(document.querySelector('.selected-scope').textContent, /第二场已结束会话/)

  await act(async () => click(document.querySelector('.scope-panel .panel-heading button')))
  await flush()
  await act(async () => harness.changed[0]({ revision: 4 }))
  await flush()
  assert.ok(scopeReads >= 4)
  assert.match(document.querySelector('.selected-scope').textContent, /第二场已结束会话/)
  assert.equal(document.querySelector('.scope-card').disabled, true)

  const [requestId, snapshot] = [...harness.summarySnapshots.entries()][0]
  const terminal = { ...snapshot, revision: snapshot.revision + 1, state: 'succeeded', phase: 'terminal' }
  harness.summarySnapshots.set(requestId, terminal)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: requestId, generation: terminal.generation, revision: terminal.revision
  }))
  await flush()
  assert.equal(document.querySelector('.scope-card').disabled, false)
  assert.match(document.querySelector('.selected-scope').textContent, /第二场已结束会话/)

  await act(async () => click(document.querySelector('.scope-panel .panel-heading button')))
  await flush()
  assert.match(document.querySelector('.selected-scope').textContent, /第二场已结束会话/)
})

test('SEM-F38/J30-PROGRESS: a recent authoritative snapshot remains the last known state during a failed read', async (t) => {
  const harness = await createHarness({
    getSessionSummaryRun: async () => ({ ok: false, error: { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' }, result: null })
  }); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  assert.equal(document.querySelector('.run-card strong').textContent, '等待处理')
  assert.equal(document.querySelector('.run-card').textContent.includes('上次确认状态'), false)
})

test('SEM-F38/J30-PROGRESS: summary status separates attempts, actual activity and memory not used', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-action="minutes"]')))
  await flush()
  const [requestId, snapshot] = [...harness.summarySnapshots.entries()][0]
  const progress = {
    ...snapshot,
    revision: snapshot.revision + 1,
    state: 'running',
    phase: 'preparing',
    attempt: 2,
    elapsed_ms: 1840,
    last_activity_age_ms: null,
    memory_state: 'not_used'
  }
  harness.summarySnapshots.set(requestId, progress)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: requestId, generation: progress.generation, revision: progress.revision
  }))
  await flush()

  const card = document.querySelector('.run-card')
  assert.match(card.textContent, /第 2 次尝试/)
  assert.match(card.textContent, /尚无实际活动记录/)
  assert.match(card.textContent, /本次未读取记忆/)

  const found = { ...progress, revision: progress.revision + 1, memory_state: 'referenced' }
  harness.summarySnapshots.set(requestId, found)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: requestId, generation: found.generation, revision: found.revision
  }))
  await flush()
  assert.match(card.textContent, /已查询到相关记忆/)

  const cancelling = { ...found, revision: found.revision + 1, state: 'cancelling', phase: 'cancelling' }
  harness.summarySnapshots.set(requestId, cancelling)
  await act(async () => harness.summaryChanged[0]({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: requestId, generation: cancelling.generation, revision: cancelling.revision
  }))
  await flush()
  assert.equal(document.querySelector('.run-card button').disabled, true)
  assert.equal(document.querySelector('.run-card button').textContent, '正在取消…')
})

test('SEM-F32/J21/J24: feedback blocks same-turn duplicates, reuses a key after unknown receipt, and only clears the submitted draft snapshot', async (t) => {
  const first = deferred()
  const second = deferred()
  let attempt = 0
  const harness = await createHarness({
    recordSignal: async () => {
      attempt += 1
      return attempt === 1 ? first.promise : second.promise
    }
  }); t.after(() => harness.dispose())
  harness.setDetail({ ...harness.historyItem, interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', result_digest: 'b'.repeat(64), routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', source_refs: [], tool_calls: [] })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  const editor = document.querySelector('#agentEdit')
  await act(async () => input(editor, '已确认版本'))
  const submitEdit = document.querySelector('[data-signal="edit"]')
  await act(async () => { click(submitEdit); click(submitEdit) })
  assert.equal(harness.signalRequests.length, 1)
  first.reject(new Error('PRIVATE failure detail'))
  await flush()
  assert.equal(editor.value, '已确认版本')
  assert.equal(document.body.textContent.includes('PRIVATE'), false)

  await act(async () => click(submitEdit))
  await flush()
  assert.equal(harness.signalRequests.length, 2)
  assert.equal(harness.signalRequests[1].signal_idempotency_key, harness.signalRequests[0].signal_idempotency_key)
  await act(async () => input(editor, '等待期间继续编辑'))
  second.resolve({ ok: true, error: null, result: { accepted: true, interaction_id: 'interaction.ui.2', replayed: false, signal_kind: 'edit' } })
  await flush()
  assert.equal(editor.value, '等待期间继续编辑')
})

test('SEM-F32/J21: successful edit feedback clears the unchanged submitted draft', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  harness.setDetail({ ...harness.historyItem, interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', result_digest: 'b'.repeat(64), routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', source_refs: [], tool_calls: [] })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  await act(async () => input(document.querySelector('#agentEdit'), '提交后清除'))
  await act(async () => click(document.querySelector('[data-signal="edit"]')))
  await flush()
  assert.equal(document.querySelector('#agentEdit').value, '')
})

test('SEM-F32/J22: an explicit successful submit ends the idempotency-key lifecycle', async (t) => {
  const harness = await createHarness({
    getInteraction: async (request, { detailById }) => ({
      ok: true,
      result: detailById.get(request.interaction_id) || {
        ...detailById.get('interaction.ui.1'), interaction_id: request.interaction_id,
        run_id: `run.${request.interaction_id}`, state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 3
      }
    })
  }); t.after(() => harness.dispose())
  const prompt = document.querySelector('#agentPrompt')
  await act(async () => input(prompt, '重复主动请求'))
  await act(async () => click(document.querySelector('[data-action="qa"]')))
  await flush()
  await act(async () => input(prompt, '重复主动请求'))
  await act(async () => click(document.querySelector('[data-action="qa"]')))
  await flush()
  assert.equal(harness.submitRequests.length, 2)
  assert.notEqual(harness.submitRequests[0].client_request_key, harness.submitRequests[1].client_request_key)
})

test('SEM-F35/J22/J26: command errors and next actions use fixed Chinese copy, and export cancellation has no success notice', async (t) => {
  const harness = await createHarness({
    submit: async () => ({ ok: false, error: { category: 'unavailable', code: 'AGENT_PROVIDER_RATE_LIMITED', next_action: 'choose_supported_recipe' }, result: null }),
    exportInteraction: async () => ({ ok: false, error: { category: 'cancelled', code: 'AGENT_RUN_INVALID', next_action: 'export_cancelled' }, result: null })
  }); t.after(() => harness.dispose())
  await act(async () => input(document.querySelector('#agentPrompt'), '失败组合'))
  await act(async () => click(document.querySelector('[data-action="qa"]')))
  await flush()
  assert.match(document.querySelector('.status').textContent, /模型服务请求过多/)
  assert.equal(document.body.textContent.includes('choose_supported_recipe'), false)
  assert.equal(document.querySelector('#agentPrompt').value, '失败组合')

  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.match(document.querySelector('.export-privacy').textContent, /导出内容可能包含字幕或个人上下文/)
  await act(async () => click([...document.querySelectorAll('button')].find((item) => item.textContent === '导出结果 JSON')))
  await flush()
  assert.match(document.querySelector('.status').textContent, /已取消导出/)
  assert.equal(document.querySelector('.status').textContent.includes('已导出交互 JSON'), false)
})

test('S5-UX/J26: terminal detail exports by interaction ID and does not expose a target path', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === '导出结果 JSON')
  assert.ok(button)
  await act(async () => click(button))
  await flush()
  assert.deepEqual(harness.exportRequests, [{ ...CONTRACT, interaction_id: 'interaction.ui.2' }])
  assert.equal(document.body.textContent.includes('已导出交互 JSON'), true)
  assert.equal(JSON.stringify(harness.exportRequests).includes('filePath'), false)
})

test('SEM-F34/J24: tool audit stays collapsed until expanded, then shows complete bounded arguments and results', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.history-card')))
  await flush()
  const audit = document.querySelector('.tool-audit')
  assert.ok(audit)
  assert.equal(audit.open, false)
  const detail = audit.querySelector('.tool-call-detail')
  assert.ok(detail)
  assert.equal(detail.open, false)
  audit.open = true
  detail.open = true
  assert.match(document.body.textContent, /"sourceRefs"/)
  assert.match(document.body.textContent, /受控来源/)
})

test('SEM-F35/J24: interaction and tool error codes render fixed Chinese explanations without internal values', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  harness.setDetail({
    ...harness.historyItem,
    interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', routing_mode: 'model', state: 'failed', terminal_reason: 'failed',
    error_code: 'AGENT_PROVIDER_TIMEOUT', result: null, result_digest: null, source_refs: [],
    tool_calls: [{ ...toolCall, status: 'failed', error_code: 'TOOL_TIMEOUT', result: null, result_digest: null }]
  })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.match(document.body.textContent, /模型响应超时/)
  assert.match(document.body.textContent, /工具调用超时/)
  assert.equal(document.body.textContent.includes('AGENT_PROVIDER_TIMEOUT'), false)
  assert.equal(document.body.textContent.includes('TOOL_TIMEOUT'), false)
})

test('SEM-F32/J21: terminal Agent results expose only explicit interaction signals', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  harness.setDetail({
    interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', recipe_id: 'qa.answer', recipe_version: '1',
    routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 3,
    duration_ms: 24, created_at: 2, attempt_count: 1, error_code: null, result: { answer: '结果' },
    result_digest: 'b'.repeat(64), source_refs: [], tool_calls: [],
    model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' },
    usage: null, usage_state: 'unknown'
  })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()
  assert.equal(document.querySelectorAll('[data-signal]').length, 5)
  await act(async () => input(document.querySelector('#agentRemember'), '明确要保留的一条'))
  for (const kind of ['accept', 'reject', 'remember', 'forget']) {
    await act(async () => click(document.querySelector(`[data-signal="${kind}"]`)))
    await flush()
  }
  assert.deepEqual(harness.signalRequests.map((request) => request.signal_kind), ['accept', 'reject', 'remember', 'forget'])
  assert.equal(harness.signalRequests.every((request) => request.result_digest === 'b'.repeat(64)), true)
  assert.deepEqual(harness.signalRequests.map((request) => request.payload), [null, null, { text: '明确要保留的一条' }, null])
})

test('SEM-F23/J29: summary result memory selectors share native option semantics and have no side effects before explicit remember', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const digest = 'e'.repeat(64)
  harness.setDetail({
    ...harness.historyItem,
    interaction_id: 'interaction.ui.2', run_id: 'run.ui.2', recipe_id: 'summary.minutes', recipe_version: '1',
    routing_mode: 'model', state: 'succeeded', terminal_reason: 'succeeded', terminal_at: 3,
    result_digest: digest, result: { summary: '会话总结结果' }, source_refs: [], tool_calls: [],
    model: { adapter_id: 'adapter.internal', model_id: 'model.internal', profile_id: 'profile.internal', profile_revision: 1, provider_kind: 'cloud' },
    usage: null, usage_state: 'unknown'
  })
  await act(async () => click(document.querySelectorAll('.history-card')[1]))
  await flush()

  const selectors = [...document.querySelectorAll('.remember-flow select')]
  assert.equal(selectors.length, 2)
  assert.deepEqual([...selectors[0].options].map((option) => option.value), ['decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'])
  assert.deepEqual([...selectors[1].options].map((option) => option.value), ['global', 'session'])
  await act(async () => {
    selectors[0].value = 'term'
    selectors[0].dispatchEvent(new window.Event('change', { bubbles: true }))
    selectors[1].value = 'session'
    selectors[1].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  assert.equal(harness.signalRequests.length, 0, '展开或选择本身不得产生交互记忆信号')
  assert.equal(harness.submitRequests.length, 0, '展开或选择本身不得触发 Agent 请求')
})
