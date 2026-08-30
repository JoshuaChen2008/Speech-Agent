'use strict'

/* 设置 · 个人上下文的界面行为（speech-agent.personal-context.ui@1.0.0）
   ------------------------------------------------------------------
   驱动数据全部取自 src/agent/contracts/fixtures/agent-context-ui/v1.0.0/，替身在
   收发两侧都跑生产 exact validator —— 等价于 preload 的同步校验。界面若构造出
   多键、少键、未登记枚举或未规范化语义键的请求，替身会当场记账并抛错。

   覆盖：先订阅再读取、只接受更高 revision、pending → 回执（无乐观成功）、
   revision conflict 保留编辑、删除幂等重放、停用后条目保留、处理开关不预先翻转、
   确认层可 Esc 取消并归还焦点、不可用时整类只读可重试。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { JSDOM } = require('jsdom')

const contract = require('../../src/agent/contracts/agent-context-ui')
const { loadSettingsView, loadViewModel } = require('./load-settings-view')
const { createRoot } = require('./react-dom-runtime')

const PC = loadViewModel()
const COPY = PC.PERSONAL_CONTEXT_COPY
const root = path.resolve(__dirname, '..', '..')
const FIXTURE_DIR = path.join(root, 'src', 'agent', 'contracts', 'fixtures', 'agent-context-ui', 'v1.0.0')
const HEADER = { contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION }

function fixture (name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'))
}

const OVERVIEW_READY = fixture('overview-ready').response
const OVERVIEW_EMPTY = fixture('overview-empty').response
const OVERVIEW_RELOAD = fixture('overview-reload-result').response
const OVERVIEW_SUSPENDED = fixture('overview-suspended').response
const OVERVIEW_UNAVAILABLE = fixture('overview-unavailable').response
const MEMORY_PAGE = fixture('manage-view-ready').response
const EPISODE_PAGE = fixture('manage-view-episodes-ready').response
const MEMORY = MEMORY_PAGE.result.items[0]
const EPISODE = EPISODE_PAGE.result.items[0]
const REMEMBER_RESULT = fixture('manage-remember-result').response
const FORGET_RESULT = fixture('manage-forget-result').response
const DELETE_RESULT = fixture('manage-delete-result').response
const PROCESSING_RESULT = fixture('manage-set-processing-result').response
const CONFLICT = fixture('manage-revision-conflict').response
const VALIDATION_ERROR = fixture('manage-validation-error').response
const OPERATION_FAILURE = fixture('manage-operation-failure').response

function page (kind, items, hasMore = false) {
  return {
    ...HEADER,
    error: null,
    ok: true,
    result: { has_more: hasMore, items, kind, next_cursor: hasMore ? 'cursorNext' : null },
    revision: 7
  }
}

function memoryResult (operation, item, revision = 8) {
  return { ...HEADER, error: null, ok: true, result: { item, kind: 'memory_item', operation }, revision }
}

function deferred () {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function flush () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function click (element) {
  assert.ok(element, '被点击的元素必须存在')
  assert.notEqual(element.disabled, true, '被点击的元素不能处于禁用状态')
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

function press (element, key) {
  element.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key }))
}

/* 受控输入必须走 React 的 change 事件，否则 value 会被受控值覆盖回去。
   写值绕开实例上的 value 描述符（React 用它追踪上一次的受控值），派发的 input
   事件才会被识别成真实变更。react-dom 的载入顺序由 ./react-dom-runtime 负责。 */
function type (element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')
  descriptor.set.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

/* 个人上下文替身：只暴露三个冻结入口，请求与响应两侧都过生产 validator。 */
function createContextApi () {
  const calls = []
  const requests = []
  const listeners = []
  const violations = []
  const writes = []
  const state = {
    overview: OVERVIEW_READY,
    views: { personal_memories: MEMORY_PAGE, session_episodes: EPISODE_PAGE },
    throwOverview: false,
    throwSubscribe: false,
    throwWrite: false
  }
  function guard (label, assertion, value) {
    try { assertion(value) } catch (error) { violations.push(`${label}: ${error.message}`); throw error }
    return value
  }
  return {
    calls,
    listeners,
    requests,
    state,
    violations,
    writes,
    emit (revision) {
      for (const listener of [...listeners]) listener({ ...HEADER, revision })
    },
    lastWrite () { return writes[writes.length - 1] },
    api: {
      getAgentContextOverview (request) {
        calls.push('overview')
        guard('GetOverviewRequest', contract.assertGetOverviewRequest, request)
        if (state.throwOverview) throw new Error('seam rejected the request')
        return Promise.resolve(guard('GetOverviewResponse', contract.assertGetOverviewResponse, state.overview))
      },
      manageAgentContext (request) {
        guard('ManageRequest', contract.assertManageRequest, request)
        calls.push(`manage:${request.command.type}`)
        requests.push(request)
        if (request.command.type === 'view') {
          return Promise.resolve(guard('ManageResponse', contract.assertManageResponse, state.views[request.command.resource]))
        }
        if (state.throwWrite) throw new Error('seam rejected the request')
        const control = deferred()
        const write = {
          request,
          settle (response) {
            guard('ManageResponse', contract.assertManageResponse, response)
            control.resolve(response)
          }
        }
        writes.push(write)
        return control.promise
      },
      onAgentContextChanged (callback) {
        calls.push('subscribe')
        if (state.throwSubscribe) throw new Error('observer denied')
        listeners.push(callback)
        return () => {
          calls.push('unsubscribe')
          const index = listeners.indexOf(callback)
          if (index >= 0) listeners.splice(index, 1)
        }
      }
    }
  }
}

async function createHarness (prepare) {
  const SettingsView = await loadSettingsView()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const globalKeys = ['window', 'document', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent']
  const previous = Object.fromEntries(globalKeys.map((key) => [key, global[key]]))
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent
  })
  global.IS_REACT_ACT_ENVIRONMENT = true

  const context = createContextApi()
  if (typeof prepare === 'function') prepare(context)
  dom.window.ManualWindowDrag = {
    bindManualWindowDrag: () => ({ end () {} }),
    isInteractiveDragEvent: () => false
  }
  dom.window.shell = {
    closeSettings () {}, dragStart () {}, dragEnd () {},
    onConfig: () => () => {}, onSnapshot: () => () => {}, onModelStatus: () => () => {}, onNavigate: () => () => {},
    getConfig: async () => ({
      theme: 'dark', systemDark: true, fontSize: 30, opacity: 0.86, toolbarOpacity: 0.82,
      barColor: null, radius: 10, latency: 160, loopback: true, mic: false,
      refinementEnabled: false, onboardingCompleted: true
    }),
    getSnapshot: async () => ({ revision: 1, sessionId: null, capabilities: { availableProfiles: ['fast'], limitations: [] } }),
    getModelStatus: async () => ({
      schemaVersion: 1,
      core: { state: 'ready', progress: 1, downloadedBytes: 1, totalBytes: 1, error: null },
      refinement: { state: 'missing', progress: 0, downloadedBytes: 0, totalBytes: 1, error: null },
      resources: [], canInstall: false, canInstallRefinement: true, canCancelInstall: false
    }),
    setConfig: async () => ({ ok: true }),
    selectPreset: async () => ({ ok: true }),
    installModelResources: async () => ({ ok: false }),
    installRefinementModel: async () => ({ ok: false }),
    cancelModelInstall: async () => ({ ok: false }),
    setRefinementPreference: async () => ({ ok: false }),
    ...context.api
  }

  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(SettingsView)))
  await flush()
  return {
    context,
    dom,
    async open () {
      await act(async () => click(document.querySelector('.nav-item[data-pane="context"]')))
      await flush()
    },
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
      assert.deepEqual(context.violations, [], '所有请求与响应都必须通过生产 exact validator')
    }
  }
}

function contextText () {
  return document.querySelector('[data-pane="context"]').textContent
}

test('SEM-F30/J21: 类别激活后先订阅 changed 再读取 overview，并呈现有界会话经历记录', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  assert.deepEqual(harness.context.calls, [], '未激活的类别不发起任何个人上下文调用')

  await harness.open()
  assert.deepEqual(harness.context.calls, ['subscribe', 'overview', 'manage:view'])
  const view = harness.context.requests[0]
  assert.equal(view.command.resource, 'session_episodes')
  assert.equal(view.command.limit, 20)
  assert.equal(view.command.cursor, null)

  const rows = document.querySelectorAll('#pcEpisodes .pc-item')
  assert.equal(rows.length, 1)
  const row = rows[0].querySelector('.pc-row')
  assert.equal(row.getAttribute('aria-label'), PC.episodeRowName(EPISODE))
  assert.equal(row.getAttribute('aria-expanded'), 'false')
  await act(async () => click(row))
  await flush()
  assert.equal(row.getAttribute('aria-expanded'), 'true')
  assert.equal(document.querySelector('#pcEpisodes .pc-bullets li').textContent, EPISODE.summary.bullets[0])
  assert.equal(document.querySelector('.pc-omission').getAttribute('data-omission'), 'not_committed_tail')
  assert.equal(document.querySelector('.pc-omission').textContent, PC.OMISSION_LABELS.not_committed_tail)
  assert.match(document.querySelector('.pc-detail .hint').textContent, /来源引用 1 条/)

  const text = contextText()
  assert.equal(text.includes(EPISODE.episode_id), false, '不展示条目标识')
  assert.equal(text.includes('agent-context'), false, '不展示 IPC 频道')
  for (const state of contract.ELIGIBILITY_STATES) assert.equal(text.includes(state), false)
  assert.equal(/scheduler|claim|lease|wakeEpoch/i.test(text), false, '不展示或推断 scheduler 状态')
  assert.equal(document.getElementById('pcProcessingState').textContent, PC.PROCESSING_STATE_LABELS.enabled)
  assert.equal(document.getElementById('pcProcessingBoundary').textContent,
    PC.PROCESSING_BOUNDARY_LABELS.current_effective_cycle)
})

test('SEM-F30/J21: 只有高于本地已应用 revision 的 changed 事件才触发重新读取', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  const baseline = harness.context.calls.length

  await act(async () => harness.context.emit(OVERVIEW_READY.snapshot.revision))
  await flush()
  assert.equal(harness.context.calls.length, baseline, '相同 revision 不重新读取')
  await act(async () => harness.context.emit(3))
  await flush()
  assert.equal(harness.context.calls.length, baseline, '更旧的 revision 不重新读取')

  harness.context.state.overview = OVERVIEW_RELOAD
  await act(async () => harness.context.emit(OVERVIEW_RELOAD.snapshot.revision))
  await flush()
  assert.deepEqual(harness.context.calls.slice(baseline), ['overview', 'manage:view'])
  assert.equal(document.querySelector('#pcEpisodes .pc-item') !== null, true)

  await act(async () => harness.context.emit(OVERVIEW_RELOAD.snapshot.revision))
  await flush()
  assert.equal(harness.context.calls.length, baseline + 2, '已应用后的同一 revision 不再触发读取')
})

test('SEM-F30/J21: 修改个人记忆先进入 pending，权威回执到达后才呈现结果', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  assert.equal(harness.context.requests[1].command.resource, 'personal_memories')
  assert.equal(document.getElementById('pcSectionHint').textContent, COPY.memoriesHint)

  const row = document.querySelector('#pcMemories .pc-row')
  assert.equal(row.getAttribute('aria-label'), PC.memoryRowName(MEMORY))
  await act(async () => click(row))
  await flush()
  await act(async () => click(document.querySelector('[data-action="edit"]')))
  await flush()
  await act(async () => type(document.getElementById('pcDraftText'), '项目沟通偏好使用简洁结构。'))
  await flush()
  await act(async () => click(document.querySelector('[data-action="save"]')))
  await flush()

  assert.equal(document.getElementById('pcStatus').textContent, COPY.pending)
  assert.equal(document.querySelector('[data-action="save"]').getAttribute('aria-busy'), 'true')
  assert.equal(document.querySelector('#pcMemories .pc-text').textContent, MEMORY.display_text,
    'pending 期间不做乐观替换')
  const write = harness.context.lastWrite()
  assert.equal(write.request.command.type, 'update')
  assert.equal(write.request.command.expected_revision, OVERVIEW_READY.snapshot.revision)
  assert.equal(write.request.command.item_id, MEMORY.memory_id)
  assert.equal(write.request.command.item_revision, MEMORY.revision)
  assert.equal(write.request.command.entry.display_text, '项目沟通偏好使用简洁结构。')
  assert.equal(write.request.command.entry.scope.kind, MEMORY.scope.kind)
  assert.equal(write.request.command.entry.kind, MEMORY.kind)

  const updated = { ...MEMORY, display_text: '项目沟通偏好使用简洁结构。', revision: MEMORY.revision + 1 }
  harness.context.state.views.personal_memories = page('memory_page', [updated])
  harness.context.state.overview = OVERVIEW_RELOAD
  await act(async () => write.settle(memoryResult('update', updated)))
  await flush()

  assert.equal(document.getElementById('pcStatus').textContent, COPY.updateSaved)
  assert.equal(document.querySelector('#pcMemories .pc-text').textContent, '项目沟通偏好使用简洁结构。')
  assert.equal(document.getElementById('pcDraftText'), null, '回执后退出编辑态')
  assert.equal(document.getElementById('pcAlert').hidden, true)
})

test('SEM-F30/J21: revision conflict 保留编辑内容，只提供重新载入权威值', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.querySelector('#pcMemories .pc-row')))
  await flush()
  await act(async () => click(document.querySelector('[data-action="edit"]')))
  await flush()
  await act(async () => type(document.getElementById('pcDraftText'), '本地未保存的修改。'))
  await flush()
  await act(async () => click(document.querySelector('[data-action="save"]')))
  await flush()
  const calls = harness.context.calls.length

  await act(async () => harness.context.lastWrite().settle(CONFLICT))
  await flush()
  assert.equal(document.getElementById('pcAlert').hidden, false)
  assert.match(document.getElementById('pcAlert').textContent, /未写入/)
  assert.equal(document.getElementById('pcStatus').textContent, '', '冲突不留下任何成功文案')
  assert.equal(document.getElementById('pcDraftText').value, '本地未保存的修改。', '编辑必须保留')
  assert.equal(harness.context.calls.length, calls, '冲突不自动重新读取，由用户触发')
  const reload = document.getElementById('pcReload')
  assert.equal(reload.textContent, COPY.reloadAction)

  harness.context.state.overview = OVERVIEW_RELOAD
  await act(async () => click(reload))
  await flush()
  assert.deepEqual(harness.context.calls.slice(calls), ['unsubscribe', 'subscribe', 'overview', 'manage:view'],
    '重新载入走同一条先订阅再读取的路径')
})

test('SEM-F30/J21: 记住个人记忆先做本地边界校验，回执后收起表单', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.getElementById('pcRememberOpen')))
  await flush()
  assert.match(document.querySelector('.pc-remember .pc-form .hint').textContent, /范围：全局/)
  assert.deepEqual([...document.querySelectorAll('#pcRememberKind option')].map((option) => option.value),
    Object.keys(PC.MEMORY_KIND_LABELS))

  const writes = harness.context.writes.length
  await act(async () => click(document.getElementById('pcRememberSubmit')))
  await flush()
  assert.equal(harness.context.writes.length, writes, '空内容不发起 IPC')
  assert.equal(document.querySelector('.pc-remember .pc-problem').textContent, COPY.entryEmpty)

  await act(async () => type(document.getElementById('pcRememberText'), '项目代号使用“北辰”。'))
  await flush()
  await act(async () => click(document.getElementById('pcRememberSubmit')))
  await flush()
  const write = harness.context.lastWrite()
  assert.equal(write.request.command.type, 'remember')
  assert.equal(write.request.command.entry.scope.kind, 'global')
  assert.equal(write.request.command.entry.scope.reference, null)
  assert.equal(write.request.command.entry.semantic_key,
    write.request.command.entry.semantic_key.normalize('NFKC').toLowerCase())

  const item = REMEMBER_RESULT.result.item
  harness.context.state.views.personal_memories = page('memory_page', [MEMORY, item])
  await act(async () => write.settle(REMEMBER_RESULT))
  await flush()
  assert.equal(document.getElementById('pcStatus').textContent, COPY.rememberSaved)
  assert.equal(document.getElementById('pcRememberText'), null, '回执后收起表单')
  assert.equal(document.querySelectorAll('#pcMemories .pc-item').length, 2)
})

test('SEM-F30/J21: validation 失败保留输入且不提供重试入口', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.getElementById('pcRememberOpen')))
  await flush()
  await act(async () => type(document.getElementById('pcRememberText'), '不会被接受的内容。'))
  await flush()
  await act(async () => click(document.getElementById('pcRememberSubmit')))
  await flush()
  const calls = harness.context.calls.length

  await act(async () => harness.context.lastWrite().settle(VALIDATION_ERROR))
  await flush()
  assert.equal(document.getElementById('pcAlert').textContent, COPY.rejected)
  assert.equal(document.getElementById('pcReload'), null, 'validation 不给重试或重新载入入口')
  assert.equal(document.getElementById('pcRememberText').value, '不会被接受的内容。')
  assert.equal(harness.context.calls.length, calls, '不自动重试')
  assert.equal(document.getElementById('pcStatus').textContent, '')
})

test('SEM-F30/J21: 前台操作失败不宣称成功，直接重新载入权威值', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.querySelector('#pcMemories .pc-row')))
  await flush()
  await act(async () => click(document.querySelector('[data-action="edit"]')))
  await flush()
  await act(async () => type(document.getElementById('pcDraftText'), '结果未知的修改。'))
  await flush()
  await act(async () => click(document.querySelector('[data-action="save"]')))
  await flush()
  const calls = harness.context.calls.length

  await act(async () => harness.context.lastWrite().settle(OPERATION_FAILURE))
  await flush()
  assert.equal(document.getElementById('pcAlert').textContent.startsWith(COPY.unsettled), true)
  assert.equal(document.getElementById('pcStatus').textContent, '')
  assert.deepEqual(harness.context.calls.slice(calls), ['unsubscribe', 'subscribe', 'overview', 'manage:view'])
})

test('SEM-F30/J21: 停用确认层可 Esc 取消并归还焦点，回执后条目保留并标注已停用', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.querySelector('#pcMemories .pc-row')))
  await flush()
  const trigger = document.querySelector('[data-action="forget"]')
  assert.equal(trigger.getAttribute('aria-label'), PC.memoryActionName('forgetAction', MEMORY))

  const writes = harness.context.writes.length
  await act(async () => click(trigger))
  await flush()
  assert.equal(document.getElementById('pcConfirmBody').textContent, COPY.forgetConfirm)
  assert.equal(document.querySelector('.pc-confirm-target').textContent, MEMORY.display_text)
  assert.equal(document.activeElement.id, 'pcConfirm', '确认层接收焦点')

  await act(async () => press(document.getElementById('pcConfirm'), 'Escape'))
  await flush()
  assert.equal(document.getElementById('pcConfirm'), null)
  assert.equal(document.activeElement, trigger, '取消后焦点回到触发控件')
  assert.equal(harness.context.writes.length, writes, '取消未提交的本地意图不发起 IPC')

  await act(async () => click(document.querySelector('[data-action="forget"]')))
  await flush()
  await act(async () => click(document.getElementById('pcConfirmAccept')))
  await flush()
  const write = harness.context.lastWrite()
  assert.equal(write.request.command.type, 'forget')
  assert.equal(write.request.command.item_id, MEMORY.memory_id)
  assert.equal(write.request.command.item_revision, MEMORY.revision)

  const forgotten = FORGET_RESULT.result.item
  harness.context.state.views.personal_memories = page('memory_page', [forgotten])
  harness.context.state.overview = OVERVIEW_RELOAD
  await act(async () => write.settle(FORGET_RESULT))
  await flush()
  assert.equal(document.getElementById('pcStatus').textContent, COPY.forgetSaved)
  const item = document.querySelector('#pcMemories .pc-item')
  assert.equal(item.dataset.lifecycle, 'forgotten', '停用后条目保留在列表里')
  assert.equal(item.querySelector('[data-field="lifecycle"]').textContent, PC.LIFECYCLE_LABELS.forgotten)
})

test('SEM-F30/J21: 删除用条目自身标识作幂等键，回执按作用对象报告计数', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.querySelector('#pcMemories .pc-row')))
  await flush()
  await act(async () => click(document.querySelector('[data-action="delete"]')))
  await flush()
  assert.equal(document.getElementById('pcConfirmBody').textContent, COPY.deleteConfirm)
  await act(async () => click(document.getElementById('pcConfirmAccept')))
  await flush()
  const write = harness.context.lastWrite()
  assert.equal(write.request.command.type, 'delete')
  assert.equal(write.request.command.deletion_idempotency_key, MEMORY.memory_id)

  harness.context.state.views.personal_memories = page('memory_page', [])
  harness.context.state.overview = OVERVIEW_EMPTY
  await act(async () => write.settle(DELETE_RESULT))
  await flush()
  assert.equal(document.getElementById('pcStatus').textContent, PC.describeDeletion(DELETE_RESULT.result))
  assert.equal(document.getElementById('pcMemoriesEmpty').textContent, COPY.memoriesEmpty)
  assert.equal(document.querySelector('#pcSections [data-resource="personal_memories"]').textContent,
    `${COPY.memoriesTab}（0）`)

  // 结果未知时以同一 key 重放：呈现首次计数并说明本次没有新的删除。
  await act(async () => click(document.getElementById('pcSections').querySelector('[data-resource="session_episodes"]')))
  await flush()
  assert.equal(document.getElementById('pcEpisodesEmpty'), null)
})

test('SEM-F30/J21: 处理开关不预先翻转，确认后按权威回执呈现休眠', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await harness.open()
  const toggle = document.getElementById('pcProcessingToggle')
  assert.equal(toggle.checked, true)

  await act(async () => click(toggle))
  await flush()
  assert.equal(document.getElementById('pcProcessingToggle').checked, true, '确认前不翻转开关')
  assert.equal(document.getElementById('pcConfirmBody').textContent, COPY.suspendConfirm)

  await act(async () => click(document.getElementById('pcConfirmAccept')))
  await flush()
  const write = harness.context.lastWrite()
  assert.equal(write.request.command.type, 'set_processing')
  assert.equal(write.request.command.state, 'suspended')
  assert.equal(write.request.command.expected_revision, OVERVIEW_READY.snapshot.revision)
  assert.equal(document.getElementById('pcProcessingToggle').checked, true, 'pending 期间仍不翻转')
  assert.equal(document.getElementById('pcProcessingToggle').getAttribute('aria-busy'), 'true')

  harness.context.state.overview = OVERVIEW_SUSPENDED
  await act(async () => write.settle(PROCESSING_RESULT))
  await flush()
  assert.equal(document.getElementById('pcStatus').textContent, COPY.suspendedNote)
  assert.equal(document.getElementById('pcProcessingToggle').checked, false)
  assert.equal(document.getElementById('pcProcessingState').textContent, PC.PROCESSING_STATE_LABELS.suspended)
  assert.equal(document.getElementById('pcProcessingBoundary').textContent,
    PC.PROCESSING_BOUNDARY_LABELS.not_established)
})

test('SEM-F30/J21: overview 不可用时整类只读可重试，不呈现任何管理入口', async (t) => {
  const harness = await createHarness((context) => { context.state.overview = OVERVIEW_UNAVAILABLE })
  t.after(() => harness.dispose())
  await harness.open()

  assert.equal(document.getElementById('pcLoading'), null)
  const panel = document.getElementById('pcUnavailable')
  assert.equal(panel.querySelector('[role="alert"]').textContent, COPY.unavailable)
  assert.equal(document.getElementById('pcRetry').textContent, COPY.retryAction)
  for (const id of ['pcProcessingToggle', 'pcSections', 'pcMemories', 'pcEpisodes', 'pcRememberOpen']) {
    assert.equal(document.getElementById(id), null, `不可用时不得出现 ${id}`)
  }
  assert.equal(document.querySelector('[data-pane="context"] textarea'), null)

  harness.context.state.overview = OVERVIEW_READY
  const calls = harness.context.calls.length
  await act(async () => click(document.getElementById('pcRetry')))
  await flush()
  assert.deepEqual(harness.context.calls.slice(calls), ['unsubscribe', 'subscribe', 'overview', 'manage:view'])
  assert.equal(document.getElementById('pcUnavailable'), null)
  assert.equal(document.querySelector('#pcEpisodes .pc-item') !== null, true)
})

test('SEM-F30/J21: 订阅或提交被 seam 同步拒绝时整类不可用，不宣称写入成功', async (t) => {
  const harness = await createHarness((context) => { context.state.throwSubscribe = true })
  t.after(() => harness.dispose())
  await harness.open()
  assert.deepEqual(harness.context.calls, ['subscribe'], '订阅失败后不靠单独读取继续渲染')
  assert.equal(document.getElementById('pcUnavailable').querySelector('[role="alert"]').textContent, COPY.unavailable)

  harness.context.state.throwSubscribe = false
  harness.context.state.throwWrite = true
  await act(async () => click(document.getElementById('pcRetry')))
  await flush()
  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  await act(async () => click(document.querySelector('#pcMemories .pc-row')))
  await flush()
  await act(async () => click(document.querySelector('[data-action="delete"]')))
  await flush()
  const calls = harness.context.calls.length
  await act(async () => click(document.getElementById('pcConfirmAccept')))
  await flush()

  assert.equal(document.getElementById('pcAlert').textContent.startsWith(COPY.unsettled), true)
  assert.equal(document.getElementById('pcStatus').textContent, '')
  assert.deepEqual(harness.context.calls.slice(calls), ['manage:delete', 'unsubscribe', 'subscribe', 'overview', 'manage:view'])
})

test('SEM-F30/J21: 空分区呈现空态文案与计数，未载满时说明还有更多记录', async (t) => {
  const harness = await createHarness((context) => {
    context.state.overview = OVERVIEW_EMPTY
    context.state.views = {
      personal_memories: page('memory_page', [MEMORY], true),
      session_episodes: page('episode_page', [])
    }
  })
  t.after(() => harness.dispose())
  await harness.open()

  assert.equal(document.getElementById('pcEpisodesEmpty').textContent, COPY.episodesEmpty)
  assert.equal(document.getElementById('pcMoreEpisodes'), null)
  assert.equal(document.querySelector('#pcSections [data-resource="session_episodes"]').textContent,
    `${COPY.episodesTab}（0）`)

  await act(async () => click(document.querySelector('#pcSections [data-resource="personal_memories"]')))
  await flush()
  assert.equal(document.getElementById('pcMemoriesEmpty'), null)
  assert.equal(document.getElementById('pcMoreMemories').textContent, COPY.moreRecords)
  // cursor 由 Core 产出且本版本没有继续读取入口，界面只说明还有更多记录。
  assert.equal(contextText().includes('cursorNext'), false)
})
