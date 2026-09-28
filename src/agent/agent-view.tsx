import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

type Dict = Record<string, any>
type ScopeItem = { scope: { kind: 'session', reference: string }, display_name: string, started_at: string | null, ended_at: string, state: 'terminal' }
type SummaryRunSubmission = { action: 'summary' | 'question', fingerprint: string, key: string, prompt: string | null, scope: ScopeItem['scope'], scopeItem: ScopeItem, resubmitsRequestId?: string }
type SummaryScopePin = { scope: ScopeItem['scope'], scopeItem: ScopeItem, requestId: string | null }
type RecoverableSummaryRun = { scope: ScopeItem['scope'], snapshot: Dict }
type State = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled'

const CONTRACT = Object.freeze({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' })
const SUMMARY_RUN_CONTRACT = Object.freeze({ contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0' })
const SUMMARY_RUN_TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])
const SCOPE_LIMIT = 50
const HISTORY_LIMIT = 50
const EDIT_LIMIT = 4096
const DRAFT_LIMIT = 20
const CONTEXT_CONTRACT = Object.freeze({ contract_id: 'speech-agent.personal-context.ui', contract_version: '1.1.0' })
const MEMORY_KIND_LABELS: Record<string, string> = Object.freeze({
  decision: '决定',
  conclusion: '结论',
  todo: '待办',
  term: '术语',
  preference: '偏好',
  project_fact: '项目事实',
  experience: '经历'
})
const MEMORY_KINDS = Object.freeze(Object.keys(MEMORY_KIND_LABELS))

const ERROR_MESSAGES: Record<string, string> = Object.freeze({
  AGENT_RUN_UNAVAILABLE: '会话总结暂时不可用，请稍后重试',
  AGENT_RUN_INVALID: '请求内容无效，请检查后重试',
  AGENT_CANCELLED: '这次请求已取消',
  AGENT_PROVIDER_AUTH_FAILED: '模型凭据不可用，请检查现有配置',
  AGENT_PROVIDER_RATE_LIMITED: '模型服务请求过多，请稍后重试',
  AGENT_PROVIDER_UNAVAILABLE: '模型服务暂时不可用，请稍后重试',
  AGENT_PROVIDER_TIMEOUT: '模型响应超时，请再次尝试',
  AGENT_OUTPUT_INVALID: '模型结果格式不可用，请再次尝试',
  AGENT_PERMISSION_DENIED: '当前请求没有所需权限',
  AGENT_REQUEST_INVALID: '请求内容无效，请检查后重试',
  AGENT_WORKER_EXITED: '处理异常，请稍后重试',
  AGENT_INTERNAL_FAILURE: '处理异常，请稍后重试',
  AGENT_BUDGET_EXCEEDED: '本次处理已达到预算限制',
  AGENT_SUMMARY_MEMORY_READ_FAILED: '暂时无法读取记忆；可重试，或先在设置中关闭“总结时参考记忆”再重新生成',
  AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED: '会话总结输入超过当前上限；总结模型尚未调用。',
  TOOL_ARGS_INVALID: '读取请求无效，本次调用未执行',
  TOOL_SCOPE_DENIED: '这次请求不能读取所选会话',
  TOOL_NOT_AVAILABLE_FOR_RECIPE: '当前请求不能使用这个读取方式',
  TOOL_BUDGET_EXCEEDED: '本次工具调用已达到预算限制',
  TOOL_TIMEOUT: '工具调用超时',
  TOOL_CANCELLED: '工具调用已取消',
  TOOL_INTERNAL_FAILURE: '读取失败，请稍后重试'
})

const NEXT_ACTION_MESSAGES: Record<string, string> = Object.freeze({
  restart_application: '数据库升级尚未成功，字幕仍可使用。请退出应用后重新启动以重试',
  correct_input: '请检查输入后重试',
  retry: '请稍后重试',
  choose_supported_scope: '请选择一场已结束的会话',
  choose_supported_recipe: '当前请求暂不支持',
  settings: '请在设置中完成所需配置',
  wait_for_terminal: '请等这场会话结束后再试',
  choose_committed_session: '请选择包含已保存字幕的会话',
  export_cancelled: '已取消导出',
  refresh_result: '请刷新交互结果后重试',
  result_unavailable: '交互结果暂时不可用'
})

class PublicResponseError extends Error {}

function responseErrorMessage (response: Dict, fallback: string): string {
  if (response?.error?.next_action === 'restart_application') return NEXT_ACTION_MESSAGES.restart_application
  if (response?.error?.next_action === 'settings') return NEXT_ACTION_MESSAGES.settings
  return ERROR_MESSAGES[response?.error?.code] || NEXT_ACTION_MESSAGES[response?.error?.next_action] || fallback
}

function errorCodeLabel (code: unknown): string {
  return typeof code === 'string' ? ERROR_MESSAGES[code] || '会话总结生成失败，请稍后重试' : '会话总结生成失败，请稍后重试'
}

function detailErrorLabel (code: unknown, recipeId: unknown): string {
  if (code === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED' && recipeId === 'summary.minutes') return errorCodeLabel(code)
  return errorCodeLabel(code)
}

function knownInteractionState (value: unknown): State | null {
  return typeof value === 'string' && ['pending', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'].includes(value)
    ? value as State
    : null
}

function durationLabel (value: unknown): string {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? `${value} ms` : '未记录时长'
}

function unwrap<T = Dict> (response: Dict): T {
  if (!response || response.ok !== true) {
    throw new PublicResponseError(responseErrorMessage(response, 'Agent 请求暂时不可用'))
  }
  return (response.result ?? response) as T
}

function utcLabel (value: string | null): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date) : '时间未知'
}

function stateLabel (state: string | null): string {
  return ({ pending: '等待生成', running: '正在生成', succeeded: '已生成', failed: '生成失败', cancelling: '正在取消', cancelled: '已取消' } as Dict)[state || ''] || '状态未知'
}

function summaryRunStateLabel (snapshot: Dict | null): string {
  if (!snapshot) return '状态未知'
  const terminal = ({ succeeded: '已生成', failed: '生成失败', cancelled: '已取消' } as Dict)[snapshot.state]
  if (terminal) return terminal
  return ({
    accepted: '已受理', preparing: '正在准备', routing: '正在确定处理方式', queued: '等待处理',
    running: '正在处理', retry_wait: '等待重试', cancelling: '正在取消'
  } as Dict)[snapshot.state] || '状态未知'
}

function summaryRunPhaseLabel (phase: unknown): string {
  return ({
    accepted: '已受理', preparing: '准备输入', waiting_model: '等待模型响应', reading_context: '读取上下文',
    reducing: '整理内容', validating: '校验结果', retry_wait: '等待重试', cancelling: '正在取消', terminal: '已结束'
  } as Dict)[String(phase || '')] || '阶段暂未记录'
}

function summaryMemoryProgressLabel (state: unknown): string {
  return ({
    not_read: '尚未读取记忆',
    not_used: '本次未读取记忆',
    empty: '已查询记忆，未找到相关记忆',
    referenced: '已查询到相关记忆',
    failed: '读取记忆失败',
    unknown: '记忆读取状态未知'
  } as Dict)[String(state || '')] || '记忆读取状态未知'
}

function summaryActivityAgeLabel (value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return '尚无实际活动记录'
  const age = Number(value)
  if (age < 1000) return '最近刚有实际活动'
  const seconds = age < 10000 ? (age / 1000).toFixed(1) : String(Math.round(age / 1000))
  return `最近实际活动 ${seconds} 秒前`
}

function summaryRunTerminal (snapshot: Dict | null): boolean {
  return !!snapshot && SUMMARY_RUN_TERMINAL_STATES.has(snapshot.state)
}

function eligibilityLabel (value: string | null): string {
  return ({
    ready: '配置已就绪，提交后检查输入容量',
    no_committed_transcript: '这场会没有已保存字幕',
    outside_automatic_window: '这场会暂时不能处理',
    agent_disabled: '请先在设置中启用 Agent',
    provider_not_configured: '先设置模型，才能生成总结',
    cloud_disclosure_required: '运行前需要确认云端模型说明',
    credential_unavailable: '模型凭据不可用，请检查设置',
    local_model_not_ready: '本地模型还没准备好',
    session_not_terminal: '这场会还没结束'
  } as Dict)[value || ''] || '当前范围不可运行'
}

function recipeLabel (recipe: string | null): string {
  return recipe === 'summary.minutes' ? '会话总结' : recipe === 'qa.answer' ? '会话问答' : '请求结果'
}

function formatValue (value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter(Boolean).join('\n')
  if (value && typeof value === 'object') return Object.entries(value as Dict).map(([key, item]) => `${key}: ${formatValue(item)}`).filter(Boolean).join('\n')
  return value === null || value === undefined ? '' : String(value)
}

function resultSections (result: unknown, recipeId: string | null = null): Array<{ label: string, value: string }> {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result as Dict : {}
  const sections: Array<[string, string[]]> = [
    ['主要内容', ['summary', 'overview', 'answer']],
    ['决定', ['conclusions', 'conclusion']],
    ['待办', ['action_items', 'actionItems', 'todos', 'todo']],
    ['需要注意', ['risks', 'risk']],
    ['未解决的问题', ['gaps', 'unresolved']],
    ['待确认', ['open_questions', 'openQuestions']]
  ]
  return sections.map(([label, keys]) => {
    const key = keys.find((candidate) => source[candidate] !== undefined)
    return { label, value: key ? formatValue(source[key]) : recipeId === 'summary.minutes' ? '未提及' : '' }
  }).filter((item) => item.value.length > 0)
}

function resultPreview (result: unknown): string {
  const first = resultSections(result)[0]
  return first?.value?.replace(/\s+/g, ' ').slice(0, 120) || '结果正文未提供'
}

function sourceCount (result: Dict | null): number {
  return Array.isArray(result?.source_refs) ? result.source_refs.length : 0
}

function memoryReferenceCount (detail: Dict | null): number | null {
  if (!detail || detail.recipe_id !== 'summary.minutes' || !Array.isArray(detail.tool_calls)) return null
  const references = new Set<string>()
  for (const call of detail.tool_calls) {
    if (call?.tool_name !== 'search_context' || call?.status !== 'succeeded') continue
    const matches = call.result?.matches
    if (!Array.isArray(matches)) continue
    for (const match of matches) {
      for (const entry of Array.isArray(match?.entries) ? match.entries : []) {
        const memory = entry?.memoryRef
        if (typeof memory?.memoryId === 'string' && typeof memory?.revisionId === 'string') {
          references.add(`${memory.memoryId}\u0000${memory.revisionId}`)
        }
      }
    }
  }
  return references.size
}

function summaryMemoryLabel (detail: Dict | null): string | null {
  if (!detail || detail.recipe_id !== 'summary.minutes') return null
  if (detail.summary_use_memory === null || detail.summary_use_memory === undefined) return '记忆使用情况未知（旧结果）'
  if (detail.summary_use_memory === false) return '本次未参考记忆'
  const searches = Array.isArray(detail.tool_calls)
    ? detail.tool_calls.filter((call: Dict) => call?.tool_name === 'search_context')
    : []
  if (searches.length === 0) return '尚未读取记忆'
  if (searches.some((call: Dict) => call.status === 'started')) return '正在读取记忆'
  const failedRead = searches.some((call: Dict) => call.status === 'failed')
  const hasSuccessfulRead = searches.some((call: Dict) => call.status === 'succeeded')
  if (!hasSuccessfulRead) return failedRead ? '读取记忆失败' : '记忆读取已取消'
  const count = typeof detail.memory_reference_count === 'number'
    ? detail.memory_reference_count
    : memoryReferenceCount(detail)
  if (count === null) return failedRead ? '记忆使用情况未知；另一次读取失败' : '记忆使用情况未知'
  if (failedRead) {
    return count === 0
      ? '部分读取失败；已成功读取的结果中未找到相关记忆'
      : `已参考 ${count} 条记忆；另一次读取失败`
  }
  return count === 0 ? '未找到相关记忆，仅依据本次会话' : `已参考 ${count} 条记忆`
}

function modelLabel (model: Dict | null): string {
  if (typeof model?.profile_id !== 'string' || typeof model?.model_id !== 'string' || !Number.isSafeInteger(model.profile_revision)) return '模型身份未知'
  return `${model.profile_id} / ${model.model_id} · 配置修订 ${model.profile_revision}`
}

function modelIdentityKey (model: Dict | null): string | null {
  if (typeof model?.adapter_id !== 'string' || typeof model?.profile_id !== 'string' || !Number.isSafeInteger(model.profile_revision) || typeof model?.model_id !== 'string' || typeof model?.provider_kind !== 'string') return null
  return JSON.stringify([model.adapter_id, model.profile_id, model.profile_revision, model.model_id, model.provider_kind])
}

function cacheRateLabel (usage: Dict): string {
  const hit = usage.cache_hit_input_tokens
  const miss = usage.cache_miss_input_tokens
  if (!Number.isSafeInteger(hit) || !Number.isSafeInteger(miss) || hit < 0 || miss < 0 || hit + miss <= 0) return '缓存命中率未知'
  return `缓存命中率 ${(hit / (hit + miss) * 100).toFixed(1)}%`
}

function usageLabel (usage: Dict | null, usageState: string): string {
  if (usageState !== 'known' || !usage) return '用量未知'
  return `输入 ${usage.input_tokens} · 输出 ${usage.output_tokens} · 来源 ${usage.usage_source} · ${cacheRateLabel(usage)}`
}

function comparisonGroups (history: Dict[]): Dict[][] {
  const groups = new Map<string, Dict[]>()
  for (const item of history) {
    if (typeof item.comparison_group_id !== 'string') continue
    const group = groups.get(item.comparison_group_id) || []
    group.push(item)
    groups.set(item.comparison_group_id, group)
  }
  return [...groups.values()].filter((group) => {
    if (group.length < 2) return false
    const identities = new Set(group.map((item) => modelIdentityKey(item.model)).filter((key): key is string => key !== null))
    return identities.size > 1
  })
}

function relativeDuration (group: Dict[], item: Dict): string {
  const durations = group.map((entry) => entry.duration_ms).filter((value) => Number.isSafeInteger(value) && value > 0)
  if (durations.length === 0 || !Number.isSafeInteger(item.duration_ms) || item.duration_ms <= 0) return '相对时长未知'
  const fastest = Math.min(...durations)
  return `相对时长 ${(item.duration_ms / fastest).toFixed(2)}×`
}

function makeIdempotencyKey (): string {
  const random = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent.ui.${random.replace(/[^a-z0-9.-]/gi, '').slice(0, 120)}`
}

function headers (): Dict { return { ...CONTRACT } }
function summaryRunHeaders (): Dict { return { ...SUMMARY_RUN_CONTRACT } }

function requestFingerprint (value: unknown): string { return JSON.stringify(value) }

function mergeByIdentity<T> (current: T[], added: T[], identity: (item: T) => string): T[] {
  const merged = new Map(current.map((item) => [identity(item), item]))
  for (const item of added) merged.set(identity(item), item)
  return [...merged.values()]
}

function scopeIdentity (scope: Dict | null): string {
  return `${scope?.kind || ''}:${scope?.reference || ''}`
}

export function AgentView (): ReactElement {
  const api = window.agentApi
  if (!api) throw new Error('agent preload bridge is missing')
  const titlebar = useRef<HTMLElement>(null)
  const scopeGeneration = useRef(0)
  const historyGeneration = useRef(0)
  const eligibilityGeneration = useRef(0)
  const acceptedRevision = useRef(0)
  const acceptedContextRevision = useRef(0)
  const detailGeneration = useRef(0)
  const detailRequestRef = useRef<{ interactionId: string, refreshAgain: boolean } | null>(null)
  const detailLastSuccessAtRef = useRef<number | null>(null)
  const requestedScopeRef = useRef<ScopeItem['scope'] | null>(null)
  const activeInteractionRef = useRef<string | null>(null)
  const summaryRequestIdentityRef = useRef<{ requestId: string, generation: number } | null>(null)
  const summarySnapshotRef = useRef<Dict | null>(null)
  const summarySnapshotReadRef = useRef<{ requestId: string, promise: Promise<void> } | null>(null)
  const summaryLastSuccessAtRef = useRef<number | null>(null)
  const recoverableSummaryGeneration = useRef(0)
  const selectedScopeRef = useRef<ScopeItem['scope'] | null>(null)
  const draftsRef = useRef(new Map<string, string>())
  const interactionStatusRef = useRef(new Map<string, string>())
  const signalStatusRef = useRef(new Map<string, string>())
  const submitLockRef = useRef(false)
  const cancelLocksRef = useRef(new Set<string>())
  const recoverableResumeLocksRef = useRef(new Set<string>())
  const exportLocksRef = useRef(new Set<string>())
  const signalLocksRef = useRef(new Set<string>())
  const pendingSubmitKeyRef = useRef<SummaryRunSubmission | null>(null)
  const summaryScopePinRef = useRef<SummaryScopePin | null>(null)
  const unresolvedSubmissionRef = useRef<SummaryRunSubmission | null>(null)
  const pendingSignalKeysRef = useRef(new Map<string, { fingerprint: string, key: string, signalKind: string }>())
  const promptRef = useRef('')
  const refreshRef = useRef<() => void>(() => {})
  const loadDetailRef = useRef<(interactionId: string | null) => Promise<void>>(async () => {})
  const reloadSummarySnapshotRef = useRef<() => void>(() => {})
  const reloadRecoverableSummaryRunsRef = useRef<() => void>(() => {})
  const recoverableSummaryRunsRef = useRef<RecoverableSummaryRun[]>([])
  const [scopes, setScopes] = useState<ScopeItem[]>([])
  const [scopeCursor, setScopeCursor] = useState<string | null>(null)
  const [selectedScope, setSelectedScope] = useState<ScopeItem['scope'] | null>(null)
  const [eligibility, setEligibility] = useState<string | null>(null)
  const [scopePending, setScopePending] = useState(true)
  const [scopeError, setScopeError] = useState('')
  const [history, setHistory] = useState<Dict[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyPending, setHistoryPending] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitPending, setSubmitPending] = useState(false)
  const [cancelPendingInteractionId, setCancelPendingInteractionId] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [activeInteractionId, setActiveInteractionId] = useState<string | null>(null)
  const [activeSummarySnapshot, setActiveSummarySnapshot] = useState<Dict | null>(null)
  const [recoverableSummaryRuns, setRecoverableSummaryRuns] = useState<RecoverableSummaryRun[]>([])
  const [recoverableSummaryPendingId, setRecoverableSummaryPendingId] = useState<string | null>(null)
  const [recoverableSummaryError, setRecoverableSummaryError] = useState('')
  const [summaryScopePin, setSummaryScopePin] = useState<SummaryScopePin | null>(null)
  const [unresolvedSubmission, setUnresolvedSubmission] = useState<SummaryRunSubmission | null>(null)
  const [summarySnapshotStale, setSummarySnapshotStale] = useState(false)
  const [summarySnapshotError, setSummarySnapshotError] = useState('')
  const [interactionStateHint, setInteractionStateHint] = useState<State | null>(null)
  const [terminalCancelStateHint, setTerminalCancelStateHint] = useState<State | null>(null)
  const [detail, setDetail] = useState<Dict | null>(null)
  const [detailPending, setDetailPending] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailStale, setDetailStale] = useState(false)
  const [exportPendingInteractionId, setExportPendingInteractionId] = useState<string | null>(null)
  const [signalPendingInteractionId, setSignalPendingInteractionId] = useState<string | null>(null)
  const [signalStatus, setSignalStatus] = useState('')
  const [editText, setEditText] = useState('')
  const [rememberText, setRememberText] = useState('')
  const [rememberKind, setRememberKind] = useState('experience')
  const [rememberScope, setRememberScope] = useState<'global' | 'session'>('global')
  const [rememberPending, setRememberPending] = useState(false)
  const [summaryMemoryEnabled, setSummaryMemoryEnabled] = useState<boolean | null>(null)
  const configRevisionRef = useRef(-1)
  const terminalCancelStateRef = useRef<State | null>(null)
  const state: State | null = terminalCancelStateHint || knownInteractionState(detail?.state) || interactionStateHint

  const clearSummaryScopePin = useCallback((requestId?: string) => {
    const pin = summaryScopePinRef.current
    if (!pin || (requestId && pin.requestId && pin.requestId !== requestId)) return
    summaryScopePinRef.current = null
    setSummaryScopePin((current) => current ? { ...current, requestId: null } : null)
  }, [])

  const applyConfig = useCallback((config: Dict) => {
    const revision = Number(config?.agentSettingsRevision)
    if (Number.isSafeInteger(revision) && revision < configRevisionRef.current) return
    if (Number.isSafeInteger(revision)) configRevisionRef.current = revision
    setSummaryMemoryEnabled(
      config?.agentEnabled === true &&
      config?.memoryEnabled === true &&
      config?.summaryUseMemory !== false
    )
  }, [])

  const loadScopes = useCallback(async (reset: boolean) => {
    const token = ++scopeGeneration.current
    setScopePending(true); setScopeError('')
    try {
      const value = await api.getScopes({ ...headers(), limit: SCOPE_LIMIT, cursor: reset ? null : scopeCursor })
      if (token !== scopeGeneration.current) return
      if (value.ok !== true) throw new PublicResponseError(responseErrorMessage(value, '范围列表暂时不可用'))
      if (Number.isSafeInteger(value.revision)) acceptedRevision.current = Math.max(acceptedRevision.current, value.revision)
      const nextScopes = value.scopes as ScopeItem[]
      setScopes((current) => reset ? nextScopes : mergeByIdentity(current, nextScopes, (item) => scopeIdentity(item.scope)))
      setScopeCursor(value.next_cursor)
      setSelectedScope((current) => {
        const visible = reset ? nextScopes : mergeByIdentity(scopes, nextScopes, (item) => scopeIdentity(item.scope))
        if (summaryScopePinRef.current) return summaryScopePinRef.current.scope
        if (requestedScopeRef.current && visible.some((item) => scopeIdentity(item.scope) === scopeIdentity(requestedScopeRef.current))) return requestedScopeRef.current
        if (current && summaryScopePin && scopeIdentity(current) === scopeIdentity(summaryScopePin.scope)) return current
        if (current && visible.some((item) => scopeIdentity(item.scope) === scopeIdentity(current))) return current
        return value.default_scope || nextScopes[0]?.scope || null
      })
    } catch (error) {
      if (token === scopeGeneration.current) setScopeError(error instanceof PublicResponseError ? error.message : '范围列表暂时不可用')
    } finally {
      if (token === scopeGeneration.current) setScopePending(false)
    }
  }, [api, scopeCursor, scopes, summaryScopePin])

  const loadHistory = useCallback(async (reset: boolean) => {
    const token = ++historyGeneration.current
    setHistoryPending(true); setHistoryError('')
    try {
      const value = unwrap<Dict>(await api.getHistory({ ...headers(), limit: HISTORY_LIMIT, cursor: reset ? null : historyCursor }))
      if (token !== historyGeneration.current) return
      setHistory((current) => reset ? value.items : mergeByIdentity(current, value.items, (item) => item.interaction_id))
      setHistoryCursor(value.next_cursor)
    } catch {
      if (token === historyGeneration.current) setHistoryError('交互历史暂时不可用')
    } finally {
      if (token === historyGeneration.current) setHistoryPending(false)
    }
  }, [api, historyCursor])

  const loadEligibility = useCallback(async (scope: ScopeItem['scope'] | null) => {
    const token = ++eligibilityGeneration.current
    if (!scope) { setEligibility(null); return }
    const identity = scopeIdentity(scope)
    setEligibility(null); setStatus('正在读取处理资格…')
    try {
      const response = await api.getEligibility({ ...headers(), scope })
      if (token !== eligibilityGeneration.current || scopeIdentity(selectedScopeRef.current) !== identity) return
      if (response.ok !== true) throw new PublicResponseError(responseErrorMessage(response, '资格快照暂时不可用'))
      setEligibility(response.snapshot.eligibility); setStatus('')
    } catch (error) {
      if (token === eligibilityGeneration.current && scopeIdentity(selectedScopeRef.current) === identity) {
        setEligibility(null); setStatus(error instanceof PublicResponseError ? error.message : '资格快照暂时不可用')
      }
    }
  }, [api])

  const refresh = useCallback(() => {
    ++scopeGeneration.current
    ++historyGeneration.current
    void loadScopes(true)
    void loadHistory(true)
    void loadEligibility(selectedScopeRef.current)
    if (activeInteractionRef.current) void loadDetailRef.current(activeInteractionRef.current)
    if (summaryRequestIdentityRef.current) reloadSummarySnapshotRef.current()
    reloadRecoverableSummaryRunsRef.current()
  }, [loadEligibility, loadHistory, loadScopes])

  const loadDetail = useCallback(async (interactionId: string | null) => {
    if (!interactionId) {
      ++detailGeneration.current
      detailRequestRef.current = null
      detailLastSuccessAtRef.current = null
      setDetail(null); setDetailError(''); setDetailPending(false); setDetailStale(false)
      return
    }
    const currentRequest = detailRequestRef.current
    if (currentRequest?.interactionId === interactionId) {
      currentRequest.refreshAgain = true
      return
    }
    const requestGeneration = ++detailGeneration.current
    const requestedRevision = acceptedRevision.current
    const requestIdentity = { interactionId, refreshAgain: false }
    detailRequestRef.current = requestIdentity
    detailLastSuccessAtRef.current ??= Date.now()
    setDetailPending(true); setDetailError('')
    try {
      const response = await api.getInteraction({ ...headers(), interaction_id: interactionId })
      if (requestGeneration !== detailGeneration.current || activeInteractionRef.current !== interactionId) return
      if (acceptedRevision.current > requestedRevision) {
        requestIdentity.refreshAgain = true
        return
      }
      const nextDetail = unwrap<Dict>(response)
      if (terminalCancelStateRef.current && knownInteractionState(nextDetail.state) !== terminalCancelStateRef.current) {
        setDetailError('交互详情暂时不可用，请刷新后重试')
        return
      }
      setDetail(nextDetail)
      const summarySnapshot = summarySnapshotRef.current
      if (summarySnapshot?.interaction_id === interactionId && ['succeeded', 'failed', 'cancelled'].includes(String(nextDetail.state))) {
        clearSummaryScopePin(summarySnapshot.request_id)
      }
      setInteractionStateHint(knownInteractionState(nextDetail.state))
      detailLastSuccessAtRef.current = Date.now()
      setDetailStale(false)
    } catch (error) {
      if (requestGeneration === detailGeneration.current && activeInteractionRef.current === interactionId) setDetailError(error instanceof PublicResponseError ? error.message : '交互详情暂时不可用')
    } finally {
      if (detailRequestRef.current === requestIdentity) {
        detailRequestRef.current = null
        if (requestGeneration === detailGeneration.current) setDetailPending(false)
        if (requestIdentity.refreshAgain && activeInteractionRef.current === interactionId) {
          queueMicrotask(() => loadDetailRef.current(interactionId))
        }
      }
    }
  }, [api, clearSummaryScopePin])

  useEffect(() => { refreshRef.current = refresh }, [refresh])
  useEffect(() => { loadDetailRef.current = loadDetail }, [loadDetail])
  useEffect(() => {
    activeInteractionRef.current = activeInteractionId
    ++detailGeneration.current
    detailRequestRef.current = null
    detailLastSuccessAtRef.current = null
    setDetail(null)
    setDetailError('')
    setDetailPending(false)
    setDetailStale(false)
    setEditText(activeInteractionId ? draftsRef.current.get(activeInteractionId) || '' : '')
    setRememberText('')
    setRememberKind('experience')
    setRememberScope('global')
    setSignalStatus(activeInteractionId ? signalStatusRef.current.get(activeInteractionId) || '' : '')
    if (activeInteractionId) setStatus(interactionStatusRef.current.get(activeInteractionId) || '')
  }, [activeInteractionId])
  useEffect(() => { selectedScopeRef.current = selectedScope }, [selectedScope])
  useEffect(() => { promptRef.current = prompt }, [prompt])

  useEffect(() => {
    const unsubscribe = api.subscribeChanged((event: Dict) => {
      if (!Number.isSafeInteger(event?.revision) || event.revision <= acceptedRevision.current) return
      acceptedRevision.current = event.revision
      refreshRef.current()
    })
    refreshRef.current()
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])

  useEffect(() => {
    if (typeof api.onAgentContextChanged !== 'function') return
    const unsubscribe = api.onAgentContextChanged((event: Dict) => {
      if (!Number.isSafeInteger(event?.revision) || event.revision <= acceptedContextRevision.current) return
      acceptedContextRevision.current = event.revision
      if (activeInteractionRef.current) void loadDetailRef.current(activeInteractionRef.current)
    })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [api])

  useEffect(() => {
    let active = true
    const dispose = typeof api.onConfig === 'function'
      ? api.onConfig((config: Dict) => {
        if (!active) return
        applyConfig(config)
        refreshRef.current()
      })
      : null
    if (typeof api.getConfig === 'function') {
      Promise.resolve(api.getConfig()).then((config: Dict) => {
        if (active) applyConfig(config)
      }).catch(() => {
        if (active && configRevisionRef.current < 0) setSummaryMemoryEnabled(null)
      })
    } else {
      setSummaryMemoryEnabled(null)
    }
    return () => { active = false; if (typeof dispose === 'function') dispose() }
  }, [api, applyConfig])

  useEffect(() => {
    if (typeof api.onRequestedScope !== 'function') return
    const dispose = api.onRequestedScope((scope: ScopeItem['scope']) => {
      if (summaryScopePinRef.current) {
        setSelectedScope(summaryScopePinRef.current.scope)
        return
      }
      requestedScopeRef.current = scope
      setSelectedScope(scope)
      setStatus('已选择这场会话')
    })
    return () => { if (typeof dispose === 'function') dispose() }
  }, [api])

  useEffect(() => {
    selectedScopeRef.current = selectedScope
    void loadEligibility(selectedScope)
  }, [loadEligibility, selectedScope])

  useEffect(() => { if (activeInteractionId) void loadDetail(activeInteractionId) }, [activeInteractionId, loadDetail])

  useEffect(() => {
    if (!activeInteractionId) return
    if (state && ['succeeded', 'failed', 'cancelled'].includes(state)) {
      setDetailStale(false)
      return
    }
    const interactionId = activeInteractionId
    let interval: number | null = null
    const poll = () => {
      if (document.visibilityState === 'hidden') return
      const lastSuccessAt = detailLastSuccessAtRef.current
      if (lastSuccessAt !== null && Date.now() - lastSuccessAt >= 10000) setDetailStale(true)
      void loadDetailRef.current(interactionId)
    }
    const stop = () => {
      if (interval !== null) window.clearInterval(interval)
      interval = null
    }
    const start = () => {
      if (document.visibilityState === 'hidden') { stop(); return }
      if (interval === null) interval = window.setInterval(poll, 2000)
      poll()
    }
    if (document.visibilityState !== 'hidden') interval = window.setInterval(poll, 2000)
    document.addEventListener('visibilitychange', start)
    return () => { stop(); document.removeEventListener('visibilitychange', start) }
  }, [activeInteractionId, detail?.state, state])

  useEffect(() => {
    const drag = window.ManualWindowDrag
    if (!drag || !titlebar.current) return
    const controller = drag.bindManualWindowDrag({ handle: titlebar.current, canStart: (event: Event) => !drag.isInteractiveDragEvent(event), onStart: () => api.dragStart(), onEnd: () => api.dragEnd() })
    const dispose = typeof api.onInteractionSync === 'function' ? api.onInteractionSync(() => controller.cancel?.()) : null
    return () => { if (typeof dispose === 'function') dispose(); controller.cancel?.() }
  }, [api])

  const selected = useMemo(() => {
    const found = scopes.find((item) => scopeIdentity(item.scope) === scopeIdentity(selectedScope))
    if (found) return found
    if (selectedScope && summaryScopePin && scopeIdentity(selectedScope) === scopeIdentity(summaryScopePin.scope)) return summaryScopePin.scopeItem
    if (selectedScope && requestedScopeRef.current && scopeIdentity(selectedScope) === scopeIdentity(requestedScopeRef.current)) {
      return { scope: selectedScope, display_name: `已选择会话 · ${selectedScope.reference}`, started_at: null, ended_at: '', state: 'terminal' } as ScopeItem
    }
    return null
  }, [scopes, selectedScope, summaryScopePin])
  const summaryRequestId = activeSummarySnapshot?.request_id || null
  const summaryTargetTerminal = !!activeSummarySnapshot?.interaction_id &&
    activeSummarySnapshot.interaction_id === activeInteractionId &&
    ['succeeded', 'failed', 'cancelled'].includes(String(detail?.state || ''))
  const activeSummaryPending = !!activeSummarySnapshot && !summaryRunTerminal(activeSummarySnapshot) &&
    !summaryTargetTerminal && activeSummarySnapshot.resume_required !== true
  const cancelPending = summaryRequestId !== null
    ? cancelPendingInteractionId === summaryRequestId
    : activeInteractionId !== null && cancelPendingInteractionId === activeInteractionId
  const exportPending = activeInteractionId !== null && exportPendingInteractionId === activeInteractionId
  const signalPending = activeInteractionId !== null && signalPendingInteractionId === activeInteractionId
  const activeRunPending = activeSummaryPending || activeInteractionId !== null && (state === null || ['pending', 'running', 'cancelling'].includes(state))
  const busy = submitPending || activeRunPending || cancelPending || exportPending || signalPending || rememberPending || unresolvedSubmission !== null
  const awaitingSummaryContinuation = activeSummarySnapshot?.action === 'summary' &&
    activeSummarySnapshot?.state === 'retry_wait' && activeSummarySnapshot?.resume_required === true
  const lostQuestionRequiresResubmission = activeSummarySnapshot?.action === 'question' &&
    activeSummarySnapshot?.state === 'failed' && activeSummarySnapshot?.error_code === 'AGENT_REQUEST_INVALID' &&
    activeSummarySnapshot?.resume_required === true
  const scopeSelectionLocked = submitPending || activeSummaryPending || unresolvedSubmission !== null ||
    awaitingSummaryContinuation || lostQuestionRequiresResubmission
  const canSubmit = eligibility === 'ready' && !busy && !awaitingSummaryContinuation && prompt.trim().length > 0 && selectedScope !== null
  const canRegenerate = detail?.recipe_id === 'summary.minutes' && ['succeeded', 'failed', 'cancelled'].includes(state || '') && selectedScope !== null && !busy
  const openSettings = () => {
    if (typeof api.openSettings === 'function') api.openSettings()
  }
  const regenerate = () => {
    if (!canRegenerate) return
    void submit('请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。', 'minutes')
  }
  const selectRecoverableSummaryRun = (item: RecoverableSummaryRun) => {
    if (!item?.scope || item.scope.kind !== 'session' || !item.snapshot) return
    summaryRequestIdentityRef.current = null
    summarySnapshotRef.current = null
    summaryLastSuccessAtRef.current = null
    setActiveSummarySnapshot(null)
    const scopeItem = scopes.find((entry) => scopeIdentity(entry.scope) === scopeIdentity(item.scope)) ||
      { scope: item.scope, display_name: '已恢复的会话', started_at: null, ended_at: '', state: 'terminal' } as ScopeItem
    const pin: SummaryScopePin = { scope: item.scope, scopeItem, requestId: item.snapshot.request_id }
    summaryScopePinRef.current = pin
    setSummaryScopePin(pin)
    setSelectedScope(item.scope)
    applySummarySnapshot(item.snapshot)
    void loadSummarySnapshot(item.snapshot.request_id)
    setStatus(item.snapshot.action === 'question' && item.snapshot.resume_required
      ? '问题内容未保留，请重新输入并提交。'
      : summaryRunStateLabel(item.snapshot))
  }
  const continueRecoveredSummaryRun = async (item: RecoverableSummaryRun) => {
    const snapshot = item?.snapshot
    if (!snapshot || snapshot.action !== 'summary' || snapshot.resume_required !== true ||
        snapshot.state !== 'retry_wait' || typeof api.resumeSessionSummaryRun !== 'function' ||
        recoverableSummaryPendingId !== null || recoverableResumeLocksRef.current.has(snapshot.request_id)) return
    recoverableResumeLocksRef.current.add(snapshot.request_id)
    setRecoverableSummaryPendingId(snapshot.request_id)
    setRecoverableSummaryError('')
    setStatus('正在继续会话总结…')
    try {
      const result = unwrap<Dict>(await api.resumeSessionSummaryRun({
        ...summaryRunHeaders(),
        request_id: snapshot.request_id,
        generation: snapshot.generation,
        expected_revision: snapshot.revision
      }))
      const resumed = result.snapshot as Dict
      selectRecoverableSummaryRun({ ...item, snapshot: resumed })
      setRecoverableSummaryRuns((current) => current.filter((entry) => entry.snapshot.request_id !== snapshot.request_id))
      void loadSummarySnapshot(snapshot.request_id)
      reloadRecoverableSummaryRunsRef.current()
      refreshRef.current()
      setStatus('已继续会话总结生成')
    } catch (error) {
      const message = error instanceof PublicResponseError ? error.message : '继续状态暂时无法确认，请刷新后重试'
      setRecoverableSummaryError(message)
      setStatus(message)
      void loadRecoverableSummaryRuns(false)
    } finally {
      recoverableResumeLocksRef.current.delete(snapshot.request_id)
      setRecoverableSummaryPendingId(null)
    }
  }
  const selectScope = (scope: ScopeItem['scope']) => {
    if (unresolvedSubmissionRef.current || summaryScopePinRef.current) return
    if (scopeIdentity(scope) !== scopeIdentity(selectedScopeRef.current)) pendingSubmitKeyRef.current = null
    requestedScopeRef.current = null
    setSummaryScopePin(null)
    setSelectedScope(scope)
  }
  const updatePrompt = (value: string) => {
    if (unresolvedSubmissionRef.current) return
    promptRef.current = value
    setPrompt(value)
  }
  const updateEditText = (value: string) => {
    if (!activeInteractionId) return
    const boundedValue = value.slice(0, EDIT_LIMIT)
    const drafts = draftsRef.current
    const current = drafts.get(activeInteractionId) || ''
    if (boundedValue.length > 0 && current.length === 0 && !drafts.has(activeInteractionId) && drafts.size >= DRAFT_LIMIT) {
      const message = '最多保留 20 条非空草稿，请先提交或清空已有草稿'
      signalStatusRef.current.set(activeInteractionId, message)
      setSignalStatus(message)
      return
    }
    if (boundedValue.length > 0) drafts.set(activeInteractionId, boundedValue)
    else drafts.delete(activeInteractionId)
    const retainedSignal = pendingSignalKeysRef.current.get(activeInteractionId)
    if (retainedSignal?.signalKind === 'edit' && detail && typeof detail.result_digest === 'string') {
      const nextFingerprint = requestFingerprint({ interaction_id: activeInteractionId, payload: { text: boundedValue.trim() }, result_digest: detail.result_digest, signal_kind: 'edit' })
      if (nextFingerprint !== retainedSignal.fingerprint) pendingSignalKeysRef.current.delete(activeInteractionId)
    }
    setEditText(boundedValue)
    if (value.length > EDIT_LIMIT) {
      const message = '编辑内容最多 4096 个字符'
      signalStatusRef.current.set(activeInteractionId, message)
      setSignalStatus(message)
    } else if (signalStatusRef.current.get(activeInteractionId)?.startsWith('最多保留') || signalStatusRef.current.get(activeInteractionId)?.startsWith('编辑内容最多')) {
      signalStatusRef.current.delete(activeInteractionId)
      setSignalStatus('')
    }
  }
  const updateRememberText = (value: string) => {
    const boundedValue = value.slice(0, EDIT_LIMIT)
    setRememberText(boundedValue)
    if (value.length > EDIT_LIMIT) setSignalStatus('要记住的内容最多 4096 个字符')
    else if (signalStatus === '要记住的内容最多 4096 个字符') setSignalStatus('')
  }
  const selectInteraction = useCallback((interactionId: string | null, stateHint: State | null) => {
    ++detailGeneration.current
    detailRequestRef.current = null
    detailLastSuccessAtRef.current = null
    summaryRequestIdentityRef.current = null
    summarySnapshotRef.current = null
    summaryLastSuccessAtRef.current = null
    activeInteractionRef.current = interactionId
    setDetail(null)
    setDetailError('')
    setDetailPending(false)
    setDetailStale(false)
    setActiveSummarySnapshot(null)
    setSummarySnapshotStale(false)
    setSummarySnapshotError('')
    setInteractionStateHint(stateHint)
    terminalCancelStateRef.current = null
    setTerminalCancelStateHint(null)
    setActiveInteractionId(interactionId)
    if (!interactionId) {
      setDetail(null); setDetailError(''); setDetailPending(false); setDetailStale(false)
    }
  }, [])
  const applySummarySnapshot = useCallback((snapshot: Dict) => {
    const identity = summaryRequestIdentityRef.current
    if (identity && (identity.requestId !== snapshot.request_id || identity.generation !== snapshot.generation)) return
    const current = summarySnapshotRef.current
    if (current && current.request_id === snapshot.request_id && current.generation === snapshot.generation &&
        Number.isSafeInteger(snapshot.revision) && snapshot.revision < current.revision) return
    const nextIdentity = { requestId: snapshot.request_id, generation: snapshot.generation }
    const newRequest = !identity || identity.requestId !== snapshot.request_id || identity.generation !== snapshot.generation
    if (typeof snapshot.interaction_id === 'string' && activeInteractionRef.current !== snapshot.interaction_id) {
      selectInteraction(snapshot.interaction_id, null)
    } else if (newRequest && snapshot.interaction_id === null && activeInteractionRef.current) {
      selectInteraction(null, null)
    }
    summaryRequestIdentityRef.current = nextIdentity
    summarySnapshotRef.current = snapshot
    summaryLastSuccessAtRef.current = Date.now()
    if (summaryRunTerminal(snapshot)) clearSummaryScopePin(snapshot.request_id)
    setActiveSummarySnapshot(snapshot)
    setSummarySnapshotStale(false)
    setSummarySnapshotError('')
  }, [clearSummaryScopePin, selectInteraction])
  const loadSummarySnapshot = useCallback(async (requestId: string) => {
    const identity = summaryRequestIdentityRef.current
    if (!identity || identity.requestId !== requestId || typeof api.getSessionSummaryRun !== 'function') return
    const currentRead = summarySnapshotReadRef.current
    if (currentRead?.requestId === requestId) return currentRead.promise
    const read = { requestId, promise: Promise.resolve() as Promise<void> }
    const task = (async () => {
      try {
        const response = await api.getSessionSummaryRun({ ...summaryRunHeaders(), request_id: requestId })
        if (summaryRequestIdentityRef.current?.requestId !== requestId) return
        if (response?.ok !== true || !response?.result?.snapshot) {
          throw new PublicResponseError(responseErrorMessage(response, '状态暂时无法确认'))
        }
        applySummarySnapshot(response.result.snapshot)
      } catch (error) {
        if (summaryRequestIdentityRef.current?.requestId !== requestId) return
        const lastSuccessAt = summaryLastSuccessAtRef.current
        setSummarySnapshotStale(lastSuccessAt === null || Date.now() - lastSuccessAt >= 10000)
        setSummarySnapshotError(error instanceof PublicResponseError ? error.message : '状态暂时无法确认')
      } finally {
        if (summarySnapshotReadRef.current === read) summarySnapshotReadRef.current = null
      }
    })()
    read.promise = task
    summarySnapshotReadRef.current = read
    return task
  }, [api, applySummarySnapshot])
  const loadRecoverableSummaryRuns = useCallback(async (selectNewest = false) => {
    const token = ++recoverableSummaryGeneration.current
    setRecoverableSummaryError('')
    if (typeof api.listRecoverableSessionSummaryRuns !== 'function') {
      setRecoverableSummaryRuns([])
      return
    }
    try {
      const response = await api.listRecoverableSessionSummaryRuns(summaryRunHeaders())
      if (token !== recoverableSummaryGeneration.current) return
      if (response?.ok !== true || !Array.isArray(response?.result?.requests)) {
        throw new PublicResponseError(responseErrorMessage(response, '恢复请求暂时不可用'))
      }
      const requests = (response.result.requests as RecoverableSummaryRun[])
        .filter((item) => item?.snapshot?.resume_required === true)
      recoverableSummaryRunsRef.current = requests
      setRecoverableSummaryRuns(requests)
      if (selectNewest && !summaryRequestIdentityRef.current && !activeInteractionRef.current) {
        const first = requests.find((item) => item?.snapshot?.resume_required === true)
        if (first?.scope?.kind === 'session' && typeof first.scope.reference === 'string' && first.snapshot) {
          const scopeItem: ScopeItem = {
            scope: first.scope, display_name: '已恢复的会话', started_at: null, ended_at: '', state: 'terminal'
          }
          const pin: SummaryScopePin = { scope: first.scope, scopeItem, requestId: first.snapshot.request_id }
          summaryScopePinRef.current = pin
          setSummaryScopePin(pin)
          setSelectedScope(first.scope)
          applySummarySnapshot(first.snapshot)
        }
      }
    } catch (error) {
      if (token === recoverableSummaryGeneration.current) {
        setRecoverableSummaryError(error instanceof PublicResponseError ? error.message : '恢复请求暂时不可用')
      }
    }
  }, [api, applySummarySnapshot])
  reloadRecoverableSummaryRunsRef.current = () => { void loadRecoverableSummaryRuns(false) }
  useEffect(() => {
    void loadRecoverableSummaryRuns(true)
    return () => { ++recoverableSummaryGeneration.current }
  }, [loadRecoverableSummaryRuns])
  reloadSummarySnapshotRef.current = () => {
    const identity = summaryRequestIdentityRef.current
    if (identity) void loadSummarySnapshot(identity.requestId)
  }
  useEffect(() => {
    if (typeof api.onSessionSummaryRunChanged !== 'function') return
    const dispose = api.onSessionSummaryRunChanged((event: Dict) => {
      const identity = summaryRequestIdentityRef.current
      const snapshot = summarySnapshotRef.current
      if (identity && event.request_id === identity.requestId && event.generation === identity.generation) {
        if (!snapshot || event.revision >= snapshot.revision) void loadSummarySnapshot(identity.requestId)
      }
      const recoverable = recoverableSummaryRunsRef.current.find((item) => item.snapshot.request_id === event.request_id)
      if (recoverable && event.generation === recoverable.snapshot.generation && event.revision >= recoverable.snapshot.revision) {
        reloadRecoverableSummaryRunsRef.current()
      }
    })
    return () => { if (typeof dispose === 'function') dispose() }
  }, [api, loadSummarySnapshot])
  useEffect(() => {
    const snapshot = activeSummarySnapshot
    if (!snapshot || summaryRunTerminal(snapshot) || snapshot.resume_required === true) return
    let interval: number | null = null
    const stop = () => {
      if (interval !== null) window.clearInterval(interval)
      interval = null
    }
    const poll = () => {
      if (document.visibilityState === 'hidden') return
      const lastSuccessAt = summaryLastSuccessAtRef.current
      if (lastSuccessAt !== null && Date.now() - lastSuccessAt >= 10000) setSummarySnapshotStale(true)
      void loadSummarySnapshot(snapshot.request_id)
    }
    const start = () => {
      if (document.visibilityState === 'hidden') { stop(); return }
      if (interval === null) interval = window.setInterval(poll, 2000)
      poll()
    }
    start()
    document.addEventListener('visibilitychange', start)
    return () => { stop(); document.removeEventListener('visibilitychange', start) }
  }, [activeSummarySnapshot?.request_id, activeSummarySnapshot?.state, activeSummarySnapshot?.resume_required, loadSummarySnapshot])
  const submit = async (value: string, recipe: 'minutes' | 'qa') => {
    if (submitLockRef.current) return
    const unresolved = unresolvedSubmissionRef.current
    if (!unresolved && (!selectedScope || eligibility !== 'ready')) return
    const action = recipe === 'minutes' ? 'summary' : 'question'
    if (unresolved && unresolved.action !== action) return
    const normalized = unresolved?.prompt || value.trim()
    if (action === 'question' && !normalized) return
    const scope = unresolved?.scope || selectedScope
    if (!scope) return
    const resubmitsRequestId = action === 'question' && lostQuestionRequiresResubmission
      ? activeSummarySnapshot?.request_id
      : undefined
    const fingerprint = unresolved?.fingerprint || requestFingerprint({
      scope, action, prompt: action === 'question' ? normalized : null,
      ...(resubmitsRequestId ? { resubmitsRequestId } : {})
    })
    const idempotencyKey = unresolved?.key || makeIdempotencyKey()
    const fallbackScopeItem: ScopeItem = { scope, display_name: `已选择会话 · ${scope.reference}`, started_at: null, ended_at: '', state: 'terminal' }
    const scopeItem = unresolved?.scopeItem ||
      scopes.find((item) => scopeIdentity(item.scope) === scopeIdentity(scope)) ||
      (summaryScopePinRef.current && scopeIdentity(summaryScopePinRef.current.scope) === scopeIdentity(scope)
        ? summaryScopePinRef.current.scopeItem
        : fallbackScopeItem)
    const submission: SummaryRunSubmission = unresolved || {
      action,
      fingerprint,
      key: idempotencyKey,
      prompt: action === 'question' ? normalized : null,
      scope,
      scopeItem,
      ...(resubmitsRequestId ? { resubmitsRequestId } : {})
    }
    pendingSubmitKeyRef.current = submission
    const pin: SummaryScopePin = { scope: submission.scope, scopeItem: submission.scopeItem, requestId: summaryScopePinRef.current?.requestId || null }
    summaryScopePinRef.current = pin
    setSummaryScopePin(pin)
    setSelectedScope(submission.scope)
    if (!unresolved) {
      summaryRequestIdentityRef.current = null
      summarySnapshotRef.current = null
      summaryLastSuccessAtRef.current = null
      setActiveSummarySnapshot(null)
      setSummarySnapshotStale(false)
      setSummarySnapshotError('')
    }
    submitLockRef.current = true
    setSubmitPending(true); setStatus(recipe === 'minutes' ? '正在生成会话总结…' : '正在提交会话问题…'); setDetailError('')
    let acceptedReceipt = false
    let receiptUnknown = true
    try {
      const request = {
        ...summaryRunHeaders(),
        action: submission.action,
        scope: submission.scope,
        client_request_key: idempotencyKey,
        ...(submission.action === 'question' ? { prompt: submission.prompt } : {}),
        ...(submission.resubmitsRequestId ? { resubmits_request_id: submission.resubmitsRequestId } : {})
      }
      const response = await api.acceptSessionSummaryRun(request)
      if (response?.ok !== true || response?.result?.accepted !== true || !response?.result?.snapshot) {
        if (response?.ok === false && response.error?.next_action && response.error.next_action !== 'retry') {
          receiptUnknown = false
          pendingSubmitKeyRef.current = null
          unresolvedSubmissionRef.current = null
          setUnresolvedSubmission(null)
          clearSummaryScopePin()
        }
        throw new PublicResponseError(responseErrorMessage(response, '请求未受理，请再次尝试'))
      }
      acceptedReceipt = true
      receiptUnknown = false
      const snapshot = response.result.snapshot as Dict
      if (submission.resubmitsRequestId) {
        setRecoverableSummaryRuns((current) => current.filter((item) => item.snapshot.request_id !== submission.resubmitsRequestId))
        reloadRecoverableSummaryRunsRef.current()
      }
      if (pendingSubmitKeyRef.current?.key === idempotencyKey) pendingSubmitKeyRef.current = null
      unresolvedSubmissionRef.current = null
      setUnresolvedSubmission(null)
      const acceptedPin: SummaryScopePin = { scope: submission.scope, scopeItem: submission.scopeItem, requestId: snapshot.request_id }
      summaryScopePinRef.current = acceptedPin
      setSummaryScopePin(acceptedPin)
      summaryRequestIdentityRef.current = null
      summarySnapshotRef.current = null
      setActiveSummarySnapshot(null)
      applySummarySnapshot(snapshot)
      setStatus(summaryRunStateLabel(snapshot))
      if (submission.action === 'question' && promptRef.current.trim() === submission.prompt) setPrompt('')
      void loadSummarySnapshot(snapshot.request_id)
      refresh()
    } catch (error) {
      if (!acceptedReceipt && receiptUnknown) {
        pendingSubmitKeyRef.current = submission
        unresolvedSubmissionRef.current = submission
        setUnresolvedSubmission(submission)
        const message = error instanceof PublicResponseError ? error.message : '请求受理状态暂时无法确认'
        setStatus(`${message}；重试会沿用同一请求`)
      } else if (!acceptedReceipt) {
        setStatus(error instanceof PublicResponseError ? error.message : '请求未受理，请检查后重试')
      } else {
        setStatus('请求已受理，但状态暂时无法确认')
      }
    }
    finally { submitLockRef.current = false; setSubmitPending(false) }
  }
  const retryUnresolvedSubmission = () => {
    const submission = unresolvedSubmissionRef.current
    if (!submission) return
    void submit(submission.action === 'summary' ? '会话总结' : submission.prompt || '', submission.action === 'summary' ? 'minutes' : 'qa')
  }
  const cancel = async () => {
    const summarySnapshot = summarySnapshotRef.current
    if (summarySnapshot && !summaryRunTerminal(summarySnapshot) && !summaryTargetTerminal) {
      const requestId = summarySnapshot.request_id
      if (cancelLocksRef.current.has(requestId)) return
      cancelLocksRef.current.add(requestId)
      setCancelPendingInteractionId(requestId); setStatus('正在取消生成…')
      try {
        const result = unwrap<Dict>(await api.cancelSessionSummaryRun({
          ...summaryRunHeaders(), request_id: requestId, generation: summarySnapshot.generation
        }))
        applySummarySnapshot(result.snapshot)
        setStatus(summaryRunStateLabel(result.snapshot))
        void loadSummarySnapshot(requestId)
        if (activeInteractionRef.current) void loadDetailRef.current(activeInteractionRef.current)
        refresh()
      } catch (error) {
        const message = error instanceof PublicResponseError
          ? `${error.message}；取消状态尚未确认`
          : '取消状态尚未确认，请刷新状态后重试'
        setStatus(message)
        setSummarySnapshotError(message)
        setSummarySnapshotStale(true)
        void loadSummarySnapshot(requestId)
      } finally {
        cancelLocksRef.current.delete(requestId)
        setCancelPendingInteractionId((current) => current === requestId ? null : current)
      }
      return
    }
    if (!activeInteractionId || cancelLocksRef.current.has(activeInteractionId) || !['pending', 'running'].includes(state || '')) return
    const interactionId = activeInteractionId
    cancelLocksRef.current.add(interactionId)
    setCancelPendingInteractionId(interactionId); setStatus('正在取消生成…')
    try {
      const result = unwrap<Dict>(await api.cancel({ ...headers(), interaction_id: interactionId }))
      const cancelledState = knownInteractionState(result.state)
      if (cancelledState) setInteractionStateHint(cancelledState)
      if (cancelledState && ['succeeded', 'failed', 'cancelled'].includes(cancelledState)) {
        terminalCancelStateRef.current = cancelledState
        setTerminalCancelStateHint(cancelledState)
        ++detailGeneration.current
        detailRequestRef.current = null
        detailLastSuccessAtRef.current = null
        setDetail(null)
        setDetailPending(false)
        setDetailStale(false)
      }
      const message = stateLabel(cancelledState)
      interactionStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setStatus(message)
      if (activeInteractionRef.current === interactionId) {
        void loadDetail(interactionId)
        refresh()
      } else {
        void loadHistory(true)
      }
    } catch (error) {
      const message = error instanceof PublicResponseError
        ? `${error.message}；取消状态尚未确认`
        : '取消状态尚未确认，请刷新状态后重试'
      interactionStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setStatus(message)
      if (activeInteractionRef.current === interactionId) {
        void loadDetail(interactionId)
        refresh()
      }
    }
    finally {
      cancelLocksRef.current.delete(interactionId)
      setCancelPendingInteractionId((current) => current === interactionId ? null : current)
    }
  }
  const exportInteraction = async () => {
    if (!activeInteractionId || !detail || exportLocksRef.current.has(activeInteractionId) || !['succeeded', 'failed', 'cancelled'].includes(state || '')) return
    const interactionId = activeInteractionId
    exportLocksRef.current.add(interactionId)
    setExportPendingInteractionId(interactionId); setStatus('正在准备导出结果…')
    try {
      const response = await api.exportInteraction({ ...headers(), interaction_id: interactionId })
      if (response.ok !== true) {
        if (response.error?.next_action === 'export_cancelled') {
          interactionStatusRef.current.set(interactionId, '已取消导出')
          if (activeInteractionRef.current === interactionId) setStatus('已取消导出')
          return
        }
        throw new PublicResponseError(responseErrorMessage(response, '导出暂时不可用，请稍后重试'))
      }
      interactionStatusRef.current.set(interactionId, '已导出交互 JSON')
      if (activeInteractionRef.current === interactionId) setStatus('已导出交互 JSON')
    } catch (error) {
      const message = error instanceof PublicResponseError ? error.message : '导出暂时不可用，请稍后重试'
      interactionStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setStatus(message)
    }
    finally {
      exportLocksRef.current.delete(interactionId)
      setExportPendingInteractionId((current) => current === interactionId ? null : current)
    }
  }
  const recordSignal = async (signalKind: 'edit' | 'accept' | 'reject' | 'remember' | 'forget', payload: Dict | null = null) => {
    if (!detail || state !== 'succeeded' || typeof detail.result_digest !== 'string' || signalLocksRef.current.has(detail.interaction_id)) return
    if (signalKind === 'edit' && (!payload || typeof payload.text !== 'string' || payload.text.trim().length === 0)) {
      setSignalStatus('请输入要提交的编辑内容')
      return
    }
    if (signalKind === 'remember' && (!payload || typeof payload.text !== 'string' || payload.text.trim().length === 0)) {
      setSignalStatus('请先写下要记住的一条内容')
      return
    }
    const interactionId = detail.interaction_id
    const draftSnapshot = signalKind === 'edit' ? draftsRef.current.get(interactionId) || '' : null
    const fingerprint = requestFingerprint({ interaction_id: interactionId, payload, result_digest: detail.result_digest, signal_kind: signalKind })
    const retained = pendingSignalKeysRef.current.get(interactionId)
    const idempotencyKey = retained?.fingerprint === fingerprint ? retained.key : makeIdempotencyKey()
    pendingSignalKeysRef.current.set(interactionId, { fingerprint, key: idempotencyKey, signalKind })
    signalLocksRef.current.add(interactionId)
    setSignalPendingInteractionId(interactionId); setSignalStatus('正在记录交互反馈…')
    try {
      const response = await api.recordSignal({
        ...headers(), interaction_id: interactionId, payload,
        result_digest: detail.result_digest, signal_idempotency_key: idempotencyKey, signal_kind: signalKind
      })
      if (pendingSignalKeysRef.current.get(interactionId)?.key === idempotencyKey) pendingSignalKeysRef.current.delete(interactionId)
      const result = unwrap<Dict>(response)
      if (result.accepted !== true) {
        const message = result.replayed ? '该交互反馈未重新记录' : '交互反馈未记录，请稍后重试'
        signalStatusRef.current.set(interactionId, message)
        if (activeInteractionRef.current === interactionId) setSignalStatus(message)
        return
      }
      const message = result.replayed ? '该交互反馈已记录' : '已记录交互反馈'
      signalStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setSignalStatus(message)
      if (signalKind === 'edit' && draftsRef.current.get(interactionId) === draftSnapshot) {
        draftsRef.current.delete(interactionId)
        if (activeInteractionRef.current === interactionId) setEditText('')
      }
    } catch (error) {
      const message = error instanceof PublicResponseError ? error.message : '交互反馈暂时不可用，请再次点击重试'
      signalStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setSignalStatus(message)
    }
    finally {
      signalLocksRef.current.delete(interactionId)
      setSignalPendingInteractionId((current) => current === interactionId ? null : current)
    }
  }

  const rememberExplicitly = async () => {
    if (!detail || detail.recipe_id !== 'summary.minutes' || state !== 'succeeded' || typeof detail.result_digest !== 'string') return
    const text = rememberText.trim()
    if (text.length === 0) {
      setSignalStatus('请先写下要记住的一条内容')
      return
    }
    if (!MEMORY_KINDS.includes(rememberKind) || !['global', 'session'].includes(rememberScope)) {
      setSignalStatus('请选择内容类型和保存范围')
      return
    }
    if (rememberPending) return
    setRememberPending(true)
    try {
      if (typeof api.getAgentContextOverview !== 'function' || typeof api.manageAgentContext !== 'function') {
        await recordSignal('remember', { text })
        return
      }
      setSignalStatus('正在保存这条记忆…')
      const overview = await api.getAgentContextOverview({ ...CONTEXT_CONTRACT })
      if (overview?.ok !== true || !Number.isSafeInteger(overview?.snapshot?.revision)) {
        throw new PublicResponseError('记忆设置暂时不可用，请稍后重试')
      }
      const reference = rememberScope === 'global' ? null : selectedScope?.reference
      if (rememberScope === 'session' && typeof reference !== 'string') {
        setSignalStatus('请选择一场已结束的会话后再记住内容')
        return
      }
      const response = await api.manageAgentContext({
        ...CONTEXT_CONTRACT,
        request_id: makeIdempotencyKey().replace(/^agent\.ui\./, 'agent.context.'),
        command: {
          type: 'remember',
          expected_revision: overview.snapshot.revision,
          entry: { display_text: text, kind: rememberKind, scope: { kind: rememberScope, reference } }
        }
      })
      if (response?.ok !== true) {
        const code = response?.error?.code
        setSignalStatus(code === 'AGENT_CONTEXT_REVISION_CONFLICT'
          ? '记忆刚刚发生变化，请重新载入后再试'
          : code === 'AGENT_CONTEXT_REQUEST_INVALID'
            ? '记忆内容或保存范围不符合要求，请检查后重试'
            : '这条记忆暂时没有保存，请稍后重试')
        return
      }
      setRememberText('')
      setSignalStatus('已记住这条内容')
    } catch (error) {
      setSignalStatus(error instanceof PublicResponseError ? error.message : '这条记忆暂时没有保存，请稍后重试')
    } finally {
      setRememberPending(false)
    }
  }

  const memoryLabel = summaryMemoryLabel(detail)
  const summaryMemoryHint = summaryMemoryEnabled === true
    ? '本次生成会参考相关记忆；会话问答会按记忆设置使用信息。'
    : summaryMemoryEnabled === false
      ? '本次生成只依据这场会话；会话问答会按记忆设置使用信息。'
      : '生成时会按设置中的选择；关闭后只依据这场会话。会话问答会按记忆设置使用信息。'
  return (
    <div className="agent-shell">
      <header className="agent-titlebar" id="titlebar" ref={titlebar}>
        <div><strong>会话总结</strong><span>选择一场已结束的会话，生成一份清晰的会后总结</span></div>
        <div className="title-actions"><span className="status" role="status" aria-live="polite">{status}</span><button className="close-button" type="button" onClick={() => api.close?.()} aria-label="关闭会话总结">关闭</button></div>
      </header>
      <main className="agent-layout">
        <aside className="scope-panel" aria-label="已结束的会话列表">
          <div className="panel-heading"><div><h1>已结束的会话</h1><p>{scopePending ? '正在读取会话…' : scopes.length ? `已显示 ${scopes.length} 个会话` : '暂无可用会话'}</p></div><button type="button" onClick={refresh} disabled={scopePending || historyPending}>刷新</button></div>
          {scopeError && <p className="error" role="alert">{scopeError}</p>}
          <div className="scope-list" role="list">
            {scopes.map((item) => <button type="button" role="listitem" className="scope-card" aria-current={scopeIdentity(item.scope) === scopeIdentity(selectedScope)} key={scopeIdentity(item.scope)} onClick={() => selectScope(item.scope)} disabled={scopeSelectionLocked}><strong>{utcLabel(item.ended_at)}</strong><span>{item.display_name}</span></button>)}
            {!scopePending && scopes.length === 0 && !scopeError && <p className="empty">还没有可总结的会话。如果正在监听，请先结束会话，再刷新这里。</p>}
          </div>
          {scopeCursor && <button className="more-button" type="button" onClick={() => void loadScopes(false)} disabled={scopePending}>加载更多</button>}
        </aside>

        <section className="request-panel" aria-label="生成会话总结">
          <div className="selected-scope">{selected ? <><span>本次会话</span><strong>{selected.display_name}</strong></> : <span>请选择一场已结束的会话</span>}</div>
          <div className={`eligibility ${eligibility === 'ready' ? 'ready' : ''}`} role="status">{eligibility ? eligibilityLabel(eligibility) : (selected ? '正在读取会话状态…' : '选择会话后读取状态')}</div>
          {['provider_not_configured', 'credential_unavailable', 'agent_disabled'].includes(eligibility || '') && <button type="button" className="secondary" onClick={openSettings}>去设置</button>}
          <p className="memory-policy-hint">{summaryMemoryHint}</p>
          <label className="prompt-label" htmlFor="agentPrompt">针对这次会话提问</label>
          {lostQuestionRequiresResubmission && <p className="memory-read-recovery" role="status">应用重新启动后问题内容未保留；请在下方重新输入并提交。</p>}
          <textarea id="agentPrompt" value={prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder={lostQuestionRequiresResubmission ? '原问题内容未保留，请重新输入问题。' : '例如：这场会最重要的决定是什么？'} disabled={busy || awaitingSummaryContinuation || eligibility !== 'ready'} />
          <div className="request-actions"><button type="button" className="primary" data-action="minutes" disabled={busy || awaitingSummaryContinuation || eligibility !== 'ready'} onClick={() => void submit('请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。', 'minutes')}>生成总结</button><button type="button" data-action="qa" disabled={!canSubmit} onClick={() => void submit(prompt, 'qa')}>提交问题</button></div>
          {unresolvedSubmission && <div className="run-card" aria-label="受理状态未确认"><div><span>当前请求</span><strong>受理状态暂时无法确认</strong><span>会话和请求内容已固定；重试会沿用同一请求。</span></div><button type="button" onClick={retryUnresolvedSubmission} disabled={submitPending}>重试原请求</button></div>}
          {recoverableSummaryRuns.length > 0 && <section className="recoverable-runs" aria-label="需要处理的会话总结请求"><div className="panel-heading"><div><h2>需要处理的请求</h2><p>中断的会话总结需要你明确继续。</p></div><button type="button" onClick={() => void loadRecoverableSummaryRuns(false)} disabled={recoverableSummaryPendingId !== null}>刷新</button></div>{recoverableSummaryError && <p className="error" role="alert">{recoverableSummaryError}</p>}<ul>{recoverableSummaryRuns.map((item) => { const snapshot = item.snapshot; const lostQuestion = snapshot.action === 'question' && snapshot.state === 'failed' && snapshot.error_code === 'AGENT_REQUEST_INVALID' && snapshot.resume_required === true; const scopeName = scopes.find((entry) => scopeIdentity(entry.scope) === scopeIdentity(item.scope))?.display_name || '已恢复的会话'; return <li key={`${snapshot.request_id}:${snapshot.generation}`}><strong>{scopeName}</strong><span>{lostQuestion ? '问题内容未保留，需要重新输入' : '会话总结已暂停'}</span>{!snapshot.diagnostics_available && <span role="status">诊断记录不可用</span>}<button type="button" onClick={() => lostQuestion ? selectRecoverableSummaryRun(item) : void continueRecoveredSummaryRun(item)} disabled={recoverableSummaryPendingId !== null}>{lostQuestion ? '重新输入问题' : recoverableSummaryPendingId === snapshot.request_id ? '正在继续…' : '继续生成'}</button></li> })}</ul></section>}
          {activeSummarySnapshot && <div className="run-card" aria-label="当前会话总结请求状态"><div><span>当前请求 · {summaryRunPhaseLabel(activeSummarySnapshot.phase)}</span><strong>{summarySnapshotStale ? '状态暂时无法确认' : summaryRunStateLabel(activeSummarySnapshot)}</strong>{summarySnapshotStale && <span className="stale-status" role="status">上次确认状态：{summaryRunStateLabel(activeSummarySnapshot)}；正在重新读取。</span>}{!activeSummarySnapshot.diagnostics_available && <span className="stale-status" role="status">诊断记录不可用</span>}<span>已用时 {activeSummarySnapshot.elapsed_ms} ms{activeSummarySnapshot.attempt > 0 ? ` · 第 ${activeSummarySnapshot.attempt} 次尝试` : ''}{activeSummarySnapshot.validated_chunk_count !== null ? ` · 已校验 ${activeSummarySnapshot.validated_chunk_count}/${activeSummarySnapshot.total_chunk_count} 个分块` : ''}</span><span>{summaryActivityAgeLabel(activeSummarySnapshot.last_activity_age_ms)} · {summaryMemoryProgressLabel(activeSummarySnapshot.memory_state)}</span>{summarySnapshotError && <span className="stale-status" role="status">{summarySnapshotError}</span>}</div><button type="button" onClick={() => void cancel()} disabled={cancelPending || activeSummarySnapshot.state === 'cancelling' || summaryRunTerminal(activeSummarySnapshot) || summaryTargetTerminal}>{cancelPending || activeSummarySnapshot.state === 'cancelling' ? '正在取消…' : '取消生成'}</button></div>}
          {!activeSummarySnapshot && activeInteractionId && <div className="run-card" aria-label="当前请求状态"><div><span>当前请求</span><strong>{detailStale && ['pending', 'running', 'cancelling'].includes(String(state || '')) ? '状态暂时无法确认' : stateLabel(state)}</strong>{detailStale && ['pending', 'running', 'cancelling'].includes(String(state || '')) && <span className="stale-status" role="status">上次确认状态：{stateLabel(state)}；正在重新读取。</span>}</div><button type="button" onClick={() => void cancel()} disabled={cancelPending || !['pending', 'running'].includes(state || '')}>{cancelPending ? '正在取消…' : '取消生成'}</button></div>}
          {detailError && <p className="error" role="alert">{detailError}</p>}
          {!detail && detailPending && <p className="loading">正在读取结果…</p>}
          {detail && <article className="result-card" aria-label="会话总结结果">
            <header><div><span>{recipeLabel(detail.recipe_id)}</span><strong>{detailStale && ['pending', 'running', 'cancelling'].includes(String(state || '')) ? '状态暂时无法确认' : stateLabel(detail.state)}</strong></div><small>{utcLabel(detail.terminal_at ? new Date(detail.terminal_at).toISOString() : null)} · {durationLabel(detail.duration_ms)} · {usageLabel(detail.usage, detail.usage_state)}</small></header>
            {detail.state === 'failed' && <p className="error" role="alert">{detailErrorLabel(detail.error_code, detail.recipe_id)}</p>}
            {detail.state === 'failed' && detail.recipe_id === 'summary.minutes' && detail.error_code === 'AGENT_SUMMARY_MEMORY_READ_FAILED' && <p className="memory-read-recovery" role="status">可以重试读取记忆；如果希望总结仅依据本次会话，请先在设置中关闭“总结时参考记忆”，再重新生成。</p>}
            {detail.result === null
              ? <p className="empty">{detail.state === 'failed' && detail.error_code === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED' && detail.recipe_id === 'summary.minutes' ? '这次未生成会话总结；可缩短输入，或选择内容较少的会话后重试。' : detail.state === 'failed' ? '这次总结没有生成，请重试。' : detail.state === 'cancelled' ? '这次生成已取消。' : '结果会在生成后显示。'}</p>
              : resultSections(detail.result, detail.recipe_id).map((section) => <section key={section.label}><h2>{section.label}</h2><p>{section.value}</p></section>)}
            {state === 'succeeded' && typeof detail.result_digest === 'string' && <section className="signal-actions" aria-label="这份结果需要调整吗"><h2>这份结果需要调整吗？</h2><label htmlFor="agentEdit">写下修改内容</label><textarea id="agentEdit" value={editText} maxLength={EDIT_LIMIT} onChange={(event) => updateEditText(event.target.value)} placeholder="例如：把第二项待办写得更具体" disabled={busy} /><div className="signal-buttons"><button type="button" data-signal="edit" onClick={() => void recordSignal('edit', { text: editText.trim() })} disabled={signalPending || editText.trim().length === 0}>提交修改</button><button type="button" data-signal="accept" onClick={() => void recordSignal('accept')} disabled={signalPending}>有帮助</button><button type="button" data-signal="reject" onClick={() => void recordSignal('reject')} disabled={signalPending}>不准确</button></div><div className="remember-flow"><p className="remember-hint">只保存你明确选中的一条内容；先写下原文，再选择类型和范围。</p><label htmlFor="agentRemember">要记住哪一条</label><textarea id="agentRemember" aria-label="要记住哪一条" value={rememberText} maxLength={EDIT_LIMIT} onChange={(event) => updateRememberText(event.target.value)} placeholder="例如：项目代号是北辰" disabled={busy} />{detail.recipe_id === 'summary.minutes' && <><label htmlFor="agentRememberKind">内容类型</label><select id="agentRememberKind" aria-label="内容类型" value={rememberKind} onChange={(event) => setRememberKind(event.target.value)} disabled={busy}>{MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{MEMORY_KIND_LABELS[kind]}</option>)}</select><label htmlFor="agentRememberScope">保存范围</label><select id="agentRememberScope" aria-label="保存范围" value={rememberScope} onChange={(event) => setRememberScope(event.target.value as 'global' | 'session')} disabled={busy}><option value="global">所有会话都可以使用</option><option value="session">仅这场会话</option></select></>}<button type="button" data-signal="remember" onClick={() => detail.recipe_id === 'summary.minutes' ? void rememberExplicitly() : void recordSignal('remember', { text: rememberText.trim() })} disabled={busy || rememberText.trim().length === 0}>{rememberPending ? '正在保存…' : '记住其中一条'}</button></div><button type="button" data-signal="forget" onClick={() => void recordSignal('forget')} disabled={signalPending}>不再使用</button>{signalStatus && <p className="signal-status" role="status">{signalStatus}</p>}</section>}
            <footer><span>参考来源 {sourceCount(detail)} 条</span>{memoryLabel && <span>{memoryLabel}</span>}<span>{detail.model?.provider_kind === 'cloud' ? '云端模型' : '本地模型'} · 本次使用的模型已固定</span><span className="export-privacy">导出内容可能包含字幕或个人上下文</span>{canRegenerate && <button type="button" onClick={() => regenerate()}>重新生成</button>}<button type="button" onClick={() => void exportInteraction()} disabled={exportPending || !['succeeded', 'failed', 'cancelled'].includes(state || '')}>{exportPending ? '正在导出…' : '导出结果 JSON'}</button></footer>
            {Array.isArray(detail.tool_calls) && detail.tool_calls.length > 0 && <details className="tool-audit"><summary>详细信息（{detail.tool_calls.length} 条读取记录）</summary><ol>{detail.tool_calls.map((call: Dict, index: number) => <li key={`${call.attempt}-${call.call_order}-${index}`}><div className="tool-call-heading"><span>{call.tool_name === 'search_context' ? '检索记忆' : call.tool_name === 'read_sources' ? '读取来源' : '受控读取'}</span><strong>{call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '处理中'}</strong>{call.status === 'failed' && <span>{errorCodeLabel(call.error_code)}</span>}</div><details className="tool-call-detail"><summary>查看参数与返回</summary><div><span>参数</span><pre>{JSON.stringify(call.args, null, 2)}</pre></div><div><span>返回</span><pre>{call.result === null ? '无返回值' : JSON.stringify(call.result, null, 2)}</pre></div></details></li>)}</ol></details>}
          </article>}
        </section>

        <aside className="history-panel" aria-label="会话总结记录">
          <div className="panel-heading"><div><h1>总结记录</h1><p>{historyPending ? '正在读取…' : `${history.length} 条记录`}</p></div></div>
          {historyError && <p className="error" role="alert">{historyError}</p>}
          {comparisonGroups(history).map((group) => <section className="comparison-card" aria-label="同一会话与问题的模型比较" key={group[0].comparison_group_id}><h2>模型比较</h2><p>同一会话与问题的不同模型结果</p><ul>{group.map((item) => <li key={item.interaction_id}><strong>{modelLabel(item.model)}</strong><span>{usageLabel(item.usage, item.usage_state)}</span><span>{relativeDuration(group, item)}</span></li>)}</ul></section>)}
          <div className="history-list" role="list">{history.map((item) => <button type="button" role="listitem" className="history-card" aria-current={item.interaction_id === activeInteractionId} key={item.interaction_id} onClick={() => selectInteraction(item.interaction_id, knownInteractionState(item.terminal_reason))}><strong>{recipeLabel(item.recipe_id)}</strong><span>{modelLabel(item.model)}</span><span>{utcLabel(item.terminal_at ? new Date(item.terminal_at).toISOString() : null)} · {stateLabel(item.terminal_reason)}</span><p>{resultPreview(item.result)}</p></button>)}{!historyPending && history.length === 0 && !historyError && <p className="empty">还没有生成过会话总结。</p>}</div>
          {historyCursor && <button className="more-button" type="button" onClick={() => void loadHistory(false)} disabled={historyPending}>加载更多</button>}
        </aside>
      </main>
    </div>
  )
}
