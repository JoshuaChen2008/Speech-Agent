/* 个人上下文 renderer 视图模型（speech-agent.personal-context.ui@1.0.0）
   --------------------------------------------------------------------------
   纯逻辑：构造 exact 请求、按 Core 的错误分类翻译失败、把 Core 投影转成可展示
   文本。不碰 DOM、不发 IPC、不解释原始异常字符串、不推断 scheduler 状态、
   不新增字段或枚举值。

   枚举、错误分类与校验规则的唯一定义点是 src/agent/contracts/agent-context-ui.js；
   本文件只保存与之一一对应的中文标签和请求形状。两边 drift 由
   test/ui/personal-context-view-model.test.js 与 preload 的 exact 校验双向
   fail closed —— 多一个键、少一个键或未登记枚举值都会整条载荷被拒。 */

type Dict = Record<string, any>

const CONTRACT_ID = 'speech-agent.personal-context.ui'
const CONTRACT_VERSION = '1.0.0'
const DISPLAY_TEXT_MAX_BYTES = 2048
const SEMANTIC_KEY_MAX_BYTES = 256

/** `view` 命令的页上界，与合同 §5 的 1..20 一致。 */
export const VIEW_PAGE_LIMIT = 20

/** 设置界面唯一可构造的范围：其它三值需要 Core 未投影的稳定 opaque 标识。 */
export const REMEMBER_SCOPE_KIND = 'global'

export const MEMORY_KIND_LABELS: Record<string, string> = {
  decision: '决定', conclusion: '结论', todo: '待办', term: '术语',
  preference: '偏好', project_fact: '项目事实', experience: '经验'
}
export const SCOPE_KIND_LABELS: Record<string, string> = {
  global: '全局', session: '会话', topic: '主题', project: '项目'
}
export const ORIGIN_LABELS: Record<string, string> = { explicit: '明确内容', inferred: '自动推断' }
export const LIFECYCLE_LABELS: Record<string, string> = { active: '生效中', forgotten: '已停用，不再被检索' }
export const SOURCE_KIND_LABELS: Record<string, string> = { session: '会话', interaction: '正式 Agent 交互' }
export const OMISSION_LABELS: Record<string, string> = {
  not_committed_tail: '本条未包含该会话尚未提交的尾部内容。',
  budget: '本条按有界预算做了取舍，未包含全部细节。'
}
export const PROCESSING_STATE_LABELS: Record<string, string> = {
  enabled: '处理中：终态会话完成摄取后会形成一条有界的会话经历记录。',
  suspended: '已休眠：不再摄取新的个人上下文，Agent 也取不到个人记忆；已有内容保留在这里。'
}
export const PROCESSING_BOUNDARY_LABELS: Record<string, string> = {
  current_effective_cycle: '个人记忆自动处理边界已按当前有效周期建立；更早的会话不会补处理。',
  not_established: '当前没有已建立的个人记忆自动处理边界；重新开启后从那时起建立。'
}

/* §11.4 的规范文案。「未知值降级」在 1.0.0 下不可达 —— exact validator 对未登记
   枚举值整条拒绝，界面只会进入通用不可用，所以这里不保留那条文案。 */
export const PERSONAL_CONTEXT_COPY: Record<string, string> = {
  category: '个人上下文',
  categorySub: '管理会话经历记录与个人记忆；它们只在你明确操作时改变。',
  episodesTab: '会话经历记录',
  memoriesTab: '个人记忆',
  episodesHint: '按会话或正式 Agent 交互记录发生了什么，只保留有界轨迹与来源引用，不复制字幕正文。',
  memoriesHint: '可跨任务复用的原子事实，带来源引用、修改历史与生命周期。',
  episodesEmpty: '还没有会话经历记录。终态会话完成摄取后会在这里出现一条有界记录。',
  memoriesEmpty: '还没有个人记忆。只有你明确记住或修改的内容会成为个人记忆。',
  moreRecords: '还有更多记录未载入。',
  editAction: '修改这条个人记忆',
  saveUpdate: '保存修改',
  cancelEdit: '放弃修改',
  rememberAction: '记住这条个人记忆',
  rememberScopeNote: '范围固定为全局；会话、主题与项目范围暂不可选。',
  pending: '正在提交，请稍候。',
  updateSaved: '修改已保存。',
  rememberSaved: '已记住这条个人记忆。',
  forgetSaved: '已停用这条个人记忆；它的修改历史、来源引用和会话经历记录都保留。',
  revisionConflict: '这条个人记忆已在别处更新，本次修改未写入。你的编辑仍保留，可重新载入权威值后再提交。',
  reloadAction: '重新载入权威值',
  retryAction: '重试',
  forgetAction: '停用这条个人记忆',
  forgetConfirm: '停用后这条个人记忆不再被检索，它的修改历史、来源引用和会话经历记录都保留。只有你以后明确记住或修改它才会恢复。',
  deleteAction: '删除这条个人记忆',
  deleteConfirm: '删除会移除这条个人记忆的正文、修改历史与来源引用。同一份旧来源不会再重新生成它；将来新的会话来源仍可能重新提出同样的内容。',
  deleteReplayed: '这条个人记忆已删除，本次没有产生新的删除。',
  processingLabel: '处理个人记忆',
  processingSwitch: '处理',
  suspendConfirm: '休眠后不再摄取新的会话经历记录，Agent 取不到个人记忆，既有条目不会被批量改写。',
  resumeConfirm: '重新开启会建立新的个人记忆自动处理边界；休眠期间以及更早的会话不会补处理。',
  suspendedNote: '已休眠：不再摄取新的个人上下文，Agent 也取不到个人记忆；已有内容保留在这里。',
  resumedNote: '已重新开启：从现在起的终态会话会被摄取。休眠期间以及更早的会话不会补处理。',
  confirmAction: '确认',
  dismissAction: '取消',
  loading: '正在读取个人上下文',
  unavailable: '个人上下文暂时不可用。',
  rejected: '本次操作未被接受。',
  unsettled: '这次操作的结果未确定，已重新载入权威值。',
  entryEmpty: '请先填写要记住的内容。',
  entryTooLong: '内容超出可保存的长度上限，请精简后再提交。'
}

function header (): Dict {
  return { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION }
}

/** 请求 ID 只用于关联一次调用，取受限字符集内的单调序号，不携带任何用户内容。 */
export function createRequestIds (prefix: string): (kind: string) => string {
  let sequence = 0
  return (kind: string) => { sequence += 1; return `${prefix}.${kind}.${sequence}` }
}

export function utf8Bytes (value: string): number {
  return new TextEncoder().encode(value).length
}

/** 按码点边界截断到字节上界，避免把多字节字符切成半个。 */
export function truncateToBytes (value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  let result = ''
  for (const codePoint of value) {
    if (utf8Bytes(result + codePoint) > maxBytes) break
    result += codePoint
  }
  return result
}

/* 语义键在提交前必须已经是 NFKC + casefold 全等形式（合同 §5.1）。先归一再小写
   再归一，保证 value === NFKC(value).toLowerCase()。 */
export function normalizeSemanticKey (text: string): string {
  const folded = String(text).trim().normalize('NFKC').toLowerCase().normalize('NFKC')
  return truncateToBytes(folded, SEMANTIC_KEY_MAX_BYTES)
}

/* 受控个人记忆输入：恰含可展示内容、七值类型、四值范围与规范化语义键。
   语义键由提交内容派生 —— MemoryItem 投影没有语义键，界面也不提供自由文本
   语义键输入框（见 docs/agent-ui-contract-requests.md AUI-CR-007）。 */
export function structuredEntry (input: Dict): Dict {
  const displayText = String(input.displayText ?? '').trim()
  return {
    display_text: displayText,
    kind: input.kind,
    scope: { kind: input.scopeKind, reference: input.scopeReference ?? null },
    semantic_key: normalizeSemanticKey(displayText)
  }
}

/** 本地前置校验：只覆盖合同已冻结的边界，不猜测 Core 的字段级理由。 */
export function describeEntryProblem (displayText: string): string {
  const text = String(displayText ?? '').trim()
  if (text.length === 0) return PERSONAL_CONTEXT_COPY.entryEmpty
  if (utf8Bytes(text) > DISPLAY_TEXT_MAX_BYTES) return PERSONAL_CONTEXT_COPY.entryTooLong
  if (normalizeSemanticKey(text).length === 0) return PERSONAL_CONTEXT_COPY.entryEmpty
  return ''
}

export function overviewRequest (): Dict {
  return header()
}

export function viewRequest (requestId: string, resource: string, cursor: string | null = null): Dict {
  return { ...header(), request_id: requestId, command: { type: 'view', resource, limit: VIEW_PAGE_LIMIT, cursor } }
}

export function rememberRequest (requestId: string, expectedRevision: number, entry: Dict): Dict {
  return { ...header(), request_id: requestId, command: { type: 'remember', expected_revision: expectedRevision, entry } }
}

export function updateRequest (requestId: string, expectedRevision: number, item: Dict, entry: Dict): Dict {
  return {
    ...header(),
    request_id: requestId,
    command: {
      type: 'update',
      expected_revision: expectedRevision,
      item_id: item.memory_id,
      item_revision: item.revision,
      entry
    }
  }
}

export function forgetRequest (requestId: string, expectedRevision: number, item: Dict): Dict {
  return {
    ...header(),
    request_id: requestId,
    command: {
      type: 'forget',
      expected_revision: expectedRevision,
      item_id: item.memory_id,
      item_revision: item.revision
    }
  }
}

/* 删除幂等键：Core 只按 key 匹配重放，而这次删除意图的身份就是那一条稳定条目
   标识。所以 reload 之后重新触发同一删除仍得到同一个 key，回执呈现首次计数
   并标注重放，而不是宣称又删了一遍（合同 §6.3、§8）。 */
export function deletionIdempotencyKey (memoryId: string): string {
  return memoryId
}

export function deleteRequest (requestId: string, expectedRevision: number, item: Dict): Dict {
  return {
    ...header(),
    request_id: requestId,
    command: {
      type: 'delete',
      expected_revision: expectedRevision,
      item_id: item.memory_id,
      item_revision: item.revision,
      deletion_idempotency_key: deletionIdempotencyKey(item.memory_id)
    }
  }
}

export function setProcessingRequest (requestId: string, expectedRevision: number, state: string): Dict {
  return { ...header(), request_id: requestId, command: { type: 'set_processing', expected_revision: expectedRevision, state } }
}

/** 只接受严格高于本地已应用 revision 的值；较旧或非整数一律丢弃。 */
export function isHigherRevision (applied: number | null, revision: unknown): boolean {
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return false
  return applied === null || revision > applied
}

/* 失败翻译只读 Core 的分类与下一动作，不读 code 字符串、不读 message（公开错误
   里没有 message），也不按等待时长猜可重试性。未登记分类 fail closed 成通用不
   可用且不给重试入口。 */
export function describeFailure (error: Dict | null | undefined): Dict {
  const category = typeof error?.category === 'string' ? error.category : ''
  if (category === 'conflict') {
    return { message: PERSONAL_CONTEXT_COPY.revisionConflict, action: 'reload', preserveEdits: true }
  }
  if (category === 'validation' || category === 'permission') {
    return { message: PERSONAL_CONTEXT_COPY.rejected, action: 'none', preserveEdits: true }
  }
  if (category === 'unavailable') {
    return { message: PERSONAL_CONTEXT_COPY.unavailable, action: 'retry', preserveEdits: true }
  }
  if (category === 'not_found' || category === 'failure') {
    return { message: PERSONAL_CONTEXT_COPY.unsettled, action: 'reload', preserveEdits: false }
  }
  return { message: PERSONAL_CONTEXT_COPY.unavailable, action: 'none', preserveEdits: true }
}

function offsetText (milliseconds: number): string {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** 只呈现 Core 给的相对偏移，不换算成绝对时刻。 */
export function describeRelativeRange (fromOffsetMs: number, throughOffsetMs: number): string {
  return `相对偏移 ${offsetText(fromOffsetMs)} – ${offsetText(throughOffsetMs)}`
}

export function describeUpdatedAt (value: string): string {
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`
    : ''
}

export function describeSourceReferences (count: number): string {
  return `来源引用 ${Math.max(0, Math.floor(Number(count) || 0))} 条`
}

/** 删除回执按作用对象报告计数；重放只呈现首次计数，不回显被删正文。 */
export function describeDeletion (result: Dict): string {
  if (result?.replayed === true) return PERSONAL_CONTEXT_COPY.deleteReplayed
  const deleted = result?.deleted ?? {}
  return `已删除：条目 ${deleted.items} · 修改历史 ${deleted.revisions} · 来源引用 ${deleted.evidence}。`
}

export function describeProcessingResult (memoryProcessing: Dict): string {
  return memoryProcessing?.state === 'suspended'
    ? PERSONAL_CONTEXT_COPY.suspendedNote
    : PERSONAL_CONTEXT_COPY.resumedNote
}

export function memoryScopeText (item: Dict): string {
  const kind = SCOPE_KIND_LABELS[item?.scope?.kind] ?? ''
  const label = String(item?.scope?.label ?? '')
  return label === kind || label === '' ? kind : `${kind}·${label}`
}

/* 行的可及名称写出范围、类型与来源，不只读正文首行（§11.5）。 */
export function memoryRowName (item: Dict): string {
  return [
    memoryScopeText(item),
    MEMORY_KIND_LABELS[item?.kind] ?? '',
    ORIGIN_LABELS[item?.origin] ?? '',
    LIFECYCLE_LABELS[item?.lifecycle] ?? ''
  ].filter((part) => part !== '').join(' · ') + `：${item?.display_text ?? ''}`
}

export function episodeRowName (episode: Dict): string {
  return [
    SOURCE_KIND_LABELS[episode?.source_kind] ?? '',
    memoryScopeText(episode),
    describeRelativeRange(episode?.occurred_from_offset_ms, episode?.occurred_through_offset_ms)
  ].filter((part) => part !== '').join(' · ') + `：${episode?.summary?.title ?? ''}`
}

/** 删除与停用的可及名称写出作用对象，不是裸「删除」。 */
export function memoryActionName (action: string, item: Dict): string {
  return `${PERSONAL_CONTEXT_COPY[action] ?? ''}：${memoryRowName(item)}`
}
