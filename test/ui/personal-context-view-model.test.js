'use strict'

/* 个人上下文视图模型（src/ui/shared/personal-context-ui.ts）
   ------------------------------------------------------------------
   本文件把 renderer 侧的标签、请求形状与失败翻译钉在 Core 的唯一定义点上：
   枚举与错误规则来自 src/agent/contracts/agent-context-ui.js，构造出的请求一律
   交给生产 exact validator 复核。任一侧 drift（多键、少键、未登记枚举、未规范化
   语义键）都在这里 fail closed，而不是等到 preload 拒绝整条载荷。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const contract = require('../../src/agent/contracts/agent-context-ui')
const { loadViewModel } = require('./load-settings-view')

const PC = loadViewModel()
const root = path.resolve(__dirname, '..', '..')
const FIXTURE_DIR = path.join(root, 'src', 'agent', 'contracts', 'fixtures', 'agent-context-ui', 'v1.0.0')

function fixture (name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'))
}

const READY_MEMORY = fixture('manage-view-ready').response.result.items[0]
const READY_EPISODE = fixture('manage-view-episodes-ready').response.result.items[0]

/* 错误规则表由 Core 的 ERROR_RULES 复核：下面每一行都被 assertManageResponse 当成
   生产载荷校验，写错 category / retry_policy / next_action 会直接抛错。 */
const ERROR_MATRIX = [
  ['AGENT_CONTEXT_REQUEST_INVALID', 'validation', 'none', null, 'rejected', 'none', true],
  ['AGENT_CONTEXT_PERMISSION_DENIED', 'permission', 'none', null, 'rejected', 'none', true],
  ['AGENT_CONTEXT_REVISION_CONFLICT', 'conflict', 'reload', 'reload', 'revisionConflict', 'reload', true],
  ['AGENT_CONTEXT_NOT_FOUND', 'not_found', 'reload', 'reload', 'unsettled', 'reload', false],
  ['AGENT_CONTEXT_OPERATION_FAILED', 'failure', 'reload', 'reload', 'unsettled', 'reload', false],
  ['AGENT_CONTEXT_UNAVAILABLE', 'unavailable', 'retry_same_request', 'retry', 'unavailable', 'retry', true]
]

test('SEM-F30/J21: 展示标签与 Core 枚举一一对应，不多不少', () => {
  assert.deepEqual(Object.keys(PC.MEMORY_KIND_LABELS).sort(), [...contract.MEMORY_KINDS].sort())
  assert.deepEqual(Object.keys(PC.SCOPE_KIND_LABELS).sort(), [...contract.SCOPE_KINDS].sort())
  assert.deepEqual(Object.keys(PC.ORIGIN_LABELS).sort(), ['explicit', 'inferred'])
  assert.deepEqual(Object.keys(PC.LIFECYCLE_LABELS).sort(), ['active', 'forgotten'])
  assert.deepEqual(Object.keys(PC.SOURCE_KIND_LABELS).sort(), ['interaction', 'session'])
  assert.deepEqual(Object.keys(PC.OMISSION_LABELS).sort(), ['budget', 'not_committed_tail'])
  assert.deepEqual(Object.keys(PC.PROCESSING_STATE_LABELS).sort(), ['enabled', 'suspended'])
  assert.deepEqual(Object.keys(PC.PROCESSING_BOUNDARY_LABELS).sort(), ['current_effective_cycle', 'not_established'])
  for (const label of Object.values({ ...PC.MEMORY_KIND_LABELS, ...PC.SCOPE_KIND_LABELS })) {
    assert.notEqual(label.trim(), '')
  }
  // eligibility 与 scheduler 状态都不进入展示层：S1 稳定为 provider_not_configured，
  // §11.4 没有授权文案，界面不得自行造词。
  assert.equal(contract.ELIGIBILITY_STATES.includes('provider_not_configured'), true)
  const copy = JSON.stringify(PC.PERSONAL_CONTEXT_COPY)
  for (const state of contract.ELIGIBILITY_STATES) assert.equal(copy.includes(state), false)
})

test('SEM-F30/J21: 构造的读取请求通过生产 exact validator', () => {
  contract.assertGetOverviewRequest(PC.overviewRequest())
  const nextId = PC.createRequestIds('settings.context')
  for (const resource of ['personal_memories', 'session_episodes']) {
    const request = PC.viewRequest(nextId('view'), resource)
    contract.assertManageRequest(request)
    assert.equal(request.command.limit, PC.VIEW_PAGE_LIMIT)
    assert.equal(request.command.limit <= 20, true)
    // cursor 由 Core 产出，renderer 不构造也不解释。
    assert.equal(request.command.cursor, null)
  }
  const ids = [nextId('view'), nextId('remember'), nextId('view')]
  assert.equal(new Set(ids).size, 3, 'request_id 必须逐次唯一')
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9._:-]{0,127}$/)
})

test('SEM-F30/J21: 构造的六种写请求通过生产 exact validator', () => {
  const nextId = PC.createRequestIds('settings.context')
  const entry = PC.structuredEntry({
    displayText: '  项目沟通偏好先给结论。  ', kind: 'preference', scopeKind: PC.REMEMBER_SCOPE_KIND, scopeReference: null
  })
  contract.assertManageRequest(PC.rememberRequest(nextId('remember'), 7, entry))
  contract.assertManageRequest(PC.updateRequest(nextId('update'), 7, READY_MEMORY, entry))
  contract.assertManageRequest(PC.forgetRequest(nextId('forget'), 7, READY_MEMORY))
  contract.assertManageRequest(PC.deleteRequest(nextId('delete'), 7, READY_MEMORY))
  for (const state of ['enabled', 'suspended']) {
    contract.assertManageRequest(PC.setProcessingRequest(nextId('set-processing'), 9, state))
  }

  // 设置界面只构造全局范围；其它三值需要 Core 未投影的稳定 opaque 标识。
  assert.equal(PC.REMEMBER_SCOPE_KIND, 'global')
  assert.equal(entry.scope.reference, null)
  assert.equal(entry.display_text, '项目沟通偏好先给结论。', '提交前去掉首尾空白')

  // 条目 revision 与全局 revision 分别取自 Core 投影，不用同一个数。
  const update = PC.updateRequest(nextId('update'), 7, READY_MEMORY, entry)
  assert.equal(update.command.expected_revision, 7)
  assert.equal(update.command.item_revision, READY_MEMORY.revision)
  assert.equal(update.command.item_id, READY_MEMORY.memory_id)
})

test('SEM-F30/J21: 语义键提交前已完成 NFKC + casefold 且按码点边界截断', () => {
  for (const text of ['ＡＢＣ 项目', 'Beichen', 'ﬁle 偏好', '  混合 Ｍｉｘ  ']) {
    const key = PC.normalizeSemanticKey(text)
    assert.equal(key, key.normalize('NFKC').toLowerCase())
    assert.equal(key.trim(), key)
    assert.equal(PC.utf8Bytes(key) <= 256, true)
  }
  const long = PC.normalizeSemanticKey('长'.repeat(400))
  assert.equal(PC.utf8Bytes(long) <= 256, true)
  assert.equal(long.includes('\uFFFD'), false, '不得把多字节字符切成半个')
  assert.equal(long, [...long].join(''), '截断只在码点边界发生')
  contract.assertManageRequest(PC.rememberRequest('settings.context.remember.1', 0, PC.structuredEntry({
    displayText: '长'.repeat(400), kind: 'term', scopeKind: 'global', scopeReference: null
  })))
})

test('SEM-F30/J21: 本地前置校验只覆盖合同已冻结的边界', () => {
  assert.equal(PC.describeEntryProblem('可保存的内容。'), '')
  assert.equal(PC.describeEntryProblem(''), PC.PERSONAL_CONTEXT_COPY.entryEmpty)
  assert.equal(PC.describeEntryProblem('   '), PC.PERSONAL_CONTEXT_COPY.entryEmpty)
  assert.equal(PC.describeEntryProblem('长'.repeat(700)), PC.PERSONAL_CONTEXT_COPY.entryTooLong)
  assert.equal(PC.utf8Bytes('长'.repeat(700)) > 2048, true)
  assert.equal(PC.describeEntryProblem('长'.repeat(680)), '', '上界之内不拦截')
})

test('SEM-F30/J21: 删除只用条目自身的稳定标识作幂等键，重放不宣称二次删除', () => {
  const first = PC.deleteRequest('settings.context.delete.1', 8, READY_MEMORY)
  const replay = PC.deleteRequest('settings.context.delete.2', 8, READY_MEMORY)
  assert.equal(replay.command.deletion_idempotency_key, first.command.deletion_idempotency_key)
  assert.equal(first.command.deletion_idempotency_key, READY_MEMORY.memory_id)

  const result = fixture('manage-delete-result').response.result
  assert.equal(PC.describeDeletion(result), '已删除：条目 1 · 修改历史 3 · 来源引用 2。')
  assert.equal(PC.describeDeletion({ ...result, replayed: true }), PC.PERSONAL_CONTEXT_COPY.deleteReplayed)
  assert.equal(PC.describeDeletion({ ...result, replayed: true }).includes('1'), false, '重放不回显首次计数以外的断言')
})

test('SEM-F30/J21: 只接受严格高于本地已应用值的 revision', () => {
  assert.equal(PC.isHigherRevision(null, 0), true)
  assert.equal(PC.isHigherRevision(7, 8), true)
  assert.equal(PC.isHigherRevision(7, 7), false)
  assert.equal(PC.isHigherRevision(7, 6), false)
  for (const bad of [undefined, null, '8', 7.5, Number.NaN, -1, {}]) {
    assert.equal(PC.isHigherRevision(7, bad), false)
    assert.equal(PC.isHigherRevision(null, bad), false)
  }
  const event = fixture('changed-reload').event
  contract.assertChangedEvent(event)
  assert.equal(PC.isHigherRevision(fixture('overview-ready').response.snapshot.revision, event.revision), true)
})

test('SEM-F30/J21: 失败翻译只读 Core 的错误分类，未登记分类 fail closed', () => {
  assert.deepEqual([...new Set(ERROR_MATRIX.map((row) => row[0]))].sort(), Object.values(contract.ERROR_CODES).sort())

  for (const [code, category, retryPolicy, nextAction, copyKey, action, preserveEdits] of ERROR_MATRIX) {
    const error = {
      category, code, next_action: nextAction, retry_policy: retryPolicy,
      current_revision: category === 'conflict' ? 8 : null
    }
    // Core 的 assertManageResponse 按 ERROR_RULES 复核这一行；表写错就在这里抛。
    contract.assertManageResponse({
      contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION,
      error, ok: false, result: null, revision: category === 'conflict' ? 8 : null
    })
    const described = PC.describeFailure(error)
    assert.equal(described.message, PC.PERSONAL_CONTEXT_COPY[copyKey])
    assert.equal(described.action, action)
    assert.equal(described.preserveEdits, preserveEdits)
    assert.equal(described.message.includes(code), false, '不回显错误码')
  }

  for (const unknown of [null, undefined, {}, { category: 'weird' }, { category: 7 }]) {
    const described = PC.describeFailure(unknown)
    assert.equal(described.message, PC.PERSONAL_CONTEXT_COPY.unavailable)
    assert.equal(described.action, 'none', '未登记分类不给重试或 reload 入口')
  }

  // 冲突保留编辑并要求重新读取权威值，不做乐观成功。
  const conflict = PC.describeFailure(fixture('manage-revision-conflict').response.error)
  assert.equal(conflict.preserveEdits, true)
  assert.equal(conflict.action, 'reload')
  assert.match(conflict.message, /未写入/)
  assert.equal(PC.describeFailure(fixture('overview-unavailable').response.error).action, 'retry')
})

test('SEM-F30/J21: 投影文本只呈现 Core 给的有界字段，不换算绝对时刻', () => {
  assert.equal(PC.describeRelativeRange(0, 60000), '相对偏移 0:00 – 1:00')
  assert.equal(PC.describeRelativeRange(0, 3725000), '相对偏移 0:00 – 1:02:05')
  assert.equal(PC.describeRelativeRange(READY_EPISODE.occurred_from_offset_ms, READY_EPISODE.occurred_through_offset_ms),
    '相对偏移 0:00 – 1:00')
  assert.equal(PC.describeUpdatedAt(READY_MEMORY.updated_at), '2000-01-01 00:00 UTC')
  assert.equal(PC.describeUpdatedAt('not-a-timestamp'), '', '非 RFC 3339 一律不呈现，不猜测时刻')
  assert.equal(PC.describeSourceReferences(READY_MEMORY.source_reference_count), '来源引用 2 条')
  assert.equal(PC.describeSourceReferences(0), '来源引用 0 条')
  assert.equal(PC.memoryScopeText(READY_MEMORY), '全局')
  assert.equal(PC.memoryScopeText(READY_EPISODE), '会话·示例会话')
  assert.equal(PC.describeProcessingResult({ state: 'suspended', automatic_processing_boundary: 'not_established' }),
    PC.PERSONAL_CONTEXT_COPY.suspendedNote)
  assert.equal(PC.describeProcessingResult(fixture('manage-set-processing-result').response.result.memory_processing),
    PC.PERSONAL_CONTEXT_COPY.suspendedNote)
  assert.equal(PC.describeProcessingResult({ state: 'enabled', automatic_processing_boundary: 'current_effective_cycle' }),
    PC.PERSONAL_CONTEXT_COPY.resumedNote)
})

test('SEM-F30/J21: 可及名称写出范围、类型、来源与作用对象，不只读正文首行', () => {
  const name = PC.memoryRowName(READY_MEMORY)
  assert.equal(name, '全局 · 偏好 · 明确内容 · 生效中：项目沟通偏好先给结论。')
  assert.equal(name.includes(READY_MEMORY.memory_id), false)
  assert.equal(String(name).includes(String(READY_MEMORY.revision)), false)
  const forgotten = PC.memoryRowName({ ...READY_MEMORY, lifecycle: 'forgotten' })
  assert.match(forgotten, /已停用，不再被检索/)
  assert.equal(PC.episodeRowName(READY_EPISODE), '会话 · 会话·示例会话 · 相对偏移 0:00 – 1:00：合成会话摘要')
  for (const action of ['forgetAction', 'deleteAction', 'editAction']) {
    const actionName = PC.memoryActionName(action, READY_MEMORY)
    assert.equal(actionName.startsWith(PC.PERSONAL_CONTEXT_COPY[action]), true)
    assert.match(actionName, /项目沟通偏好先给结论。$/)
  }
})

test('SEM-F30/J21: 文案使用授权术语，且不泄露 ID、频道、路径或原始异常', () => {
  const copy = PC.PERSONAL_CONTEXT_COPY
  const all = Object.values(copy).join('\n')
  // 术语表里的词至少各出现一次，避免文案漂移成同义说法。
  for (const term of ['个人上下文', '会话经历记录', '个人记忆', '来源引用', '个人记忆自动处理边界']) {
    assert.equal(all.includes(term), true, `缺少术语：${term}`)
  }
  // 「生命周期」是行元数据里的术语，由标签映射承担。
  assert.match(PC.PERSONAL_CONTEXT_COPY.memoriesHint, /生命周期/)
  for (const banned of ['清除记忆', 'AI 记忆', '学习了', '智能整理', '自动学习', '永久删除']) {
    assert.equal(all.includes(banned), false, `出现禁用说法：${banned}`)
  }
  for (const leak of ['agent-context:', 'AGENT_CONTEXT', 'ipcRenderer', 'scheduler', 'claim', 'wakeEpoch',
    'sqlite', 'SQLite', 'C:\\', '/Users/', 'http://', 'https://', 'memory.', 'episode.', 'stack']) {
    assert.equal(all.includes(leak), false, `文案泄露内部细节：${leak}`)
  }
  assert.equal(/[0-9]{2,}/.test(all), false, '文案不夹带 revision、计数或字节数等原值')

  // 关键状态各自有独立文案，不能靠同一句话兼用。
  const distinct = [copy.loading, copy.unavailable, copy.rejected, copy.unsettled, copy.revisionConflict,
    copy.forgetSaved, copy.rememberSaved, copy.updateSaved, copy.deleteReplayed]
  assert.equal(new Set(distinct).size, distinct.length)
  assert.match(copy.forgetSaved, /保留/)
  assert.match(copy.deleteConfirm, /将来新的会话来源仍可能重新提出同样的内容/)
  assert.match(copy.resumeConfirm, /不会补处理/)
  assert.match(copy.rememberScopeNote, /全局/)
})
