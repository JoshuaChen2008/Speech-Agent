import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

type Dict = Record<string, any>
type ScopeItem = { scope: { kind: 'session', reference: string }, display_name: string, started_at: string | null, ended_at: string, state: 'terminal' }
type State = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled'

const CONTRACT = Object.freeze({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' })
const SCOPE_LIMIT = 50
const HISTORY_LIMIT = 50
const EDIT_LIMIT = 4096
const DRAFT_LIMIT = 20

const ERROR_MESSAGES: Record<string, string> = Object.freeze({
  AGENT_RUN_UNAVAILABLE: 'Agent 服务暂时不可用，请稍后重试',
  AGENT_RUN_INVALID: '请求内容无效，请检查后重试',
  AGENT_CANCELLED: '该交互已取消',
  AGENT_PROVIDER_AUTH_FAILED: '模型凭据不可用，请检查现有配置',
  AGENT_PROVIDER_RATE_LIMITED: '模型服务请求过多，请稍后重试',
  AGENT_PROVIDER_UNAVAILABLE: '模型服务暂时不可用，请稍后重试',
  AGENT_PROVIDER_TIMEOUT: '模型响应超时，请再次尝试',
  AGENT_OUTPUT_INVALID: '模型结果格式不可用，请再次尝试',
  AGENT_PERMISSION_DENIED: '当前请求没有所需权限',
  AGENT_REQUEST_INVALID: '请求内容无效，请检查后重试',
  AGENT_WORKER_EXITED: 'Agent 运行异常，请稍后重试',
  AGENT_INTERNAL_FAILURE: 'Agent 运行异常，请稍后重试',
  AGENT_BUDGET_EXCEEDED: '本次处理已达到预算限制',
  TOOL_ARGS_INVALID: '工具参数无效，本次调用未执行',
  TOOL_SCOPE_DENIED: '工具不能读取当前范围',
  TOOL_NOT_AVAILABLE_FOR_RECIPE: '当前处理类型不能使用该工具',
  TOOL_BUDGET_EXCEEDED: '本次工具调用已达到预算限制',
  TOOL_TIMEOUT: '工具调用超时',
  TOOL_CANCELLED: '工具调用已取消',
  TOOL_INTERNAL_FAILURE: '工具调用失败，请稍后重试'
})

const NEXT_ACTION_MESSAGES: Record<string, string> = Object.freeze({
  correct_input: '请检查输入后重试',
  retry: '请稍后重试',
  choose_supported_scope: '请选择受支持的终态会话',
  choose_supported_recipe: '当前处理类型暂不支持',
  settings: '请在设置中完成所需配置',
  wait_for_terminal: '请等待会话进入终态',
  choose_committed_session: '请选择包含已提交字幕的终态会话',
  export_cancelled: '已取消导出',
  refresh_result: '请刷新交互结果后重试',
  result_unavailable: '交互结果暂时不可用'
})

class PublicResponseError extends Error {}

function responseErrorMessage (response: Dict, fallback: string): string {
  return ERROR_MESSAGES[response?.error?.code] || NEXT_ACTION_MESSAGES[response?.error?.next_action] || fallback
}

function errorCodeLabel (code: unknown): string {
  return typeof code === 'string' ? ERROR_MESSAGES[code] || 'Agent 运行失败，请稍后重试' : 'Agent 运行失败，请稍后重试'
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
  return ({ pending: '等待执行', running: '执行中', succeeded: '已生成结果', failed: '执行失败', cancelling: '正在取消', cancelled: '已取消' } as Dict)[state || ''] || '状态未知'
}

function eligibilityLabel (value: string | null): string {
  return ({
    ready: '可以运行',
    no_committed_transcript: '该会话没有可用的已提交字幕',
    outside_automatic_window: '该会话不在当前自动处理范围内',
    agent_disabled: 'Agent 系统当前已关闭',
    provider_not_configured: '尚未配置可用的 Agent 模型',
    cloud_disclosure_required: '运行前需要确认云端披露',
    credential_unavailable: '模型凭据当前不可用',
    local_model_not_ready: '本地模型尚未就绪',
    session_not_terminal: '会话尚未进入终态'
  } as Dict)[value || ''] || '当前范围不可运行'
}

function recipeLabel (recipe: string | null): string {
  return recipe === 'summary.minutes' ? '会后结构化纪要' : recipe === 'qa.answer' ? '会话问答' : '正式 Agent 交互'
}

function formatValue (value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter(Boolean).join('\n')
  if (value && typeof value === 'object') return Object.entries(value as Dict).map(([key, item]) => `${key}: ${formatValue(item)}`).filter(Boolean).join('\n')
  return value === null || value === undefined ? '' : String(value)
}

function resultSections (result: unknown): Array<{ label: string, value: string }> {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result as Dict : {}
  const sections: Array<[string, string[]]> = [
    ['概要', ['summary', 'overview', 'answer']],
    ['结论', ['conclusions', 'conclusion']],
    ['待办', ['action_items', 'actionItems', 'todos', 'todo']],
    ['风险', ['risks', 'risk']],
    ['缺口', ['gaps', 'unresolved']],
    ['待确认', ['open_questions', 'openQuestions']]
  ]
  return sections.map(([label, keys]) => {
    const key = keys.find((candidate) => source[candidate] !== undefined)
    return { label, value: key ? formatValue(source[key]) : '' }
  }).filter((item) => item.value.length > 0)
}

function resultPreview (result: unknown): string {
  const first = resultSections(result)[0]
  return first?.value?.replace(/\s+/g, ' ').slice(0, 120) || '结果正文未提供'
}

function sourceCount (result: Dict | null): number {
  return Array.isArray(result?.source_refs) ? result.source_refs.length : 0
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
  const detailGeneration = useRef(0)
  const activeInteractionRef = useRef<string | null>(null)
  const selectedScopeRef = useRef<ScopeItem['scope'] | null>(null)
  const draftsRef = useRef(new Map<string, string>())
  const interactionStatusRef = useRef(new Map<string, string>())
  const signalStatusRef = useRef(new Map<string, string>())
  const submitLockRef = useRef(false)
  const cancelLocksRef = useRef(new Set<string>())
  const exportLocksRef = useRef(new Set<string>())
  const signalLocksRef = useRef(new Set<string>())
  const pendingSubmitKeyRef = useRef<{ fingerprint: string, key: string } | null>(null)
  const pendingSignalKeysRef = useRef(new Map<string, { fingerprint: string, key: string, signalKind: string }>())
  const promptRef = useRef('')
  const refreshRef = useRef<() => void>(() => {})
  const loadDetailRef = useRef<(interactionId: string | null) => Promise<void>>(async () => {})
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
  const [detail, setDetail] = useState<Dict | null>(null)
  const [detailPending, setDetailPending] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [exportPendingInteractionId, setExportPendingInteractionId] = useState<string | null>(null)
  const [signalPendingInteractionId, setSignalPendingInteractionId] = useState<string | null>(null)
  const [signalStatus, setSignalStatus] = useState('')
  const [editText, setEditText] = useState('')

  const loadScopes = useCallback(async (reset: boolean) => {
    const token = ++scopeGeneration.current
    setScopePending(true); setScopeError('')
    try {
      const value = await api.getScopes({ ...headers(), limit: SCOPE_LIMIT, cursor: reset ? null : scopeCursor })
      if (token !== scopeGeneration.current) return
      if (value.ok !== true) throw new Error('范围列表暂时不可用')
      if (Number.isSafeInteger(value.revision)) acceptedRevision.current = Math.max(acceptedRevision.current, value.revision)
      const nextScopes = value.scopes as ScopeItem[]
      setScopes((current) => reset ? nextScopes : mergeByIdentity(current, nextScopes, (item) => scopeIdentity(item.scope)))
      setScopeCursor(value.next_cursor)
      setSelectedScope((current) => {
        const visible = reset ? nextScopes : mergeByIdentity(scopes, nextScopes, (item) => scopeIdentity(item.scope))
        if (current && visible.some((item) => scopeIdentity(item.scope) === scopeIdentity(current))) return current
        return value.default_scope || nextScopes[0]?.scope || null
      })
    } catch {
      if (token === scopeGeneration.current) setScopeError('范围列表暂时不可用')
    } finally {
      if (token === scopeGeneration.current) setScopePending(false)
    }
  }, [api, scopeCursor, scopes])

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
      if (response.ok !== true) throw new Error('资格快照暂时不可用')
      setEligibility(response.snapshot.eligibility); setStatus('')
    } catch {
      if (token === eligibilityGeneration.current && scopeIdentity(selectedScopeRef.current) === identity) {
        setEligibility(null); setStatus('资格快照暂时不可用')
      }
    }
  }, [api])

  const refresh = useCallback(() => {
    ++scopeGeneration.current
    ++historyGeneration.current
    void loadScopes(true)
    void loadHistory(true)
    void loadEligibility(selectedScopeRef.current)
  }, [loadEligibility, loadHistory, loadScopes])

  const loadDetail = useCallback(async (interactionId: string | null) => {
    const requestGeneration = ++detailGeneration.current
    if (!interactionId) { setDetail(null); setDetailError(''); setDetailPending(false); return }
    setDetailPending(true); setDetailError('')
    try {
      const response = await api.getInteraction({ ...headers(), interaction_id: interactionId })
      if (requestGeneration !== detailGeneration.current || activeInteractionRef.current !== interactionId) return
      setDetail(unwrap<Dict>(response))
    } catch (error) {
      if (requestGeneration === detailGeneration.current && activeInteractionRef.current === interactionId) setDetailError(error instanceof PublicResponseError ? error.message : '交互详情暂时不可用')
    } finally {
      if (requestGeneration === detailGeneration.current) setDetailPending(false)
    }
  }, [api])

  useEffect(() => { refreshRef.current = refresh }, [refresh])
  useEffect(() => { loadDetailRef.current = loadDetail }, [loadDetail])
  useEffect(() => {
    activeInteractionRef.current = activeInteractionId
    setDetail(null)
    setDetailError('')
    setEditText(activeInteractionId ? draftsRef.current.get(activeInteractionId) || '' : '')
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
      if (activeInteractionRef.current) void loadDetailRef.current(activeInteractionRef.current)
    })
    refreshRef.current()
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [])

  useEffect(() => {
    selectedScopeRef.current = selectedScope
    void loadEligibility(selectedScope)
  }, [loadEligibility, selectedScope])

  useEffect(() => { if (activeInteractionId) void loadDetail(activeInteractionId) }, [activeInteractionId, loadDetail])

  useEffect(() => {
    const drag = window.ManualWindowDrag
    if (!drag || !titlebar.current) return
    const controller = drag.bindManualWindowDrag({ handle: titlebar.current, canStart: (event: Event) => !drag.isInteractiveDragEvent(event), onStart: () => api.dragStart(), onEnd: () => api.dragEnd() })
    const dispose = typeof api.onInteractionSync === 'function' ? api.onInteractionSync(() => controller.cancel?.()) : null
    return () => { if (typeof dispose === 'function') dispose(); controller.cancel?.() }
  }, [api])

  const selected = useMemo(() => scopes.find((item) => item.scope.reference === selectedScope?.reference) || null, [scopes, selectedScope])
  const state: State | null = detail?.state || null
  const cancelPending = activeInteractionId !== null && cancelPendingInteractionId === activeInteractionId
  const exportPending = activeInteractionId !== null && exportPendingInteractionId === activeInteractionId
  const signalPending = activeInteractionId !== null && signalPendingInteractionId === activeInteractionId
  const busy = submitPending || cancelPending || detailPending || exportPending || signalPending
  const canSubmit = eligibility === 'ready' && !busy && prompt.trim().length > 0 && selectedScope !== null
  const selectScope = (scope: ScopeItem['scope']) => {
    if (scopeIdentity(scope) !== scopeIdentity(selectedScopeRef.current)) pendingSubmitKeyRef.current = null
    setSelectedScope(scope)
  }
  const updatePrompt = (value: string) => {
    const retainedSubmit = pendingSubmitKeyRef.current
    if (retainedSubmit && selectedScopeRef.current) {
      const nextFingerprint = requestFingerprint({ scope: selectedScopeRef.current, prompt: value.trim() })
      if (nextFingerprint !== retainedSubmit.fingerprint) pendingSubmitKeyRef.current = null
    }
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
  const submit = async (value: string, recipe: 'minutes' | 'qa') => {
    if (!selectedScope || eligibility !== 'ready' || submitLockRef.current) return
    const normalized = value.trim()
    if (!normalized) return
    const fingerprint = requestFingerprint({ scope: selectedScope, prompt: normalized })
    const retained = pendingSubmitKeyRef.current
    const idempotencyKey = retained?.fingerprint === fingerprint ? retained.key : makeIdempotencyKey()
    pendingSubmitKeyRef.current = { fingerprint, key: idempotencyKey }
    submitLockRef.current = true
    setSubmitPending(true); setStatus(recipe === 'minutes' ? '正在请求会后结构化纪要…' : '正在提交会话问答…'); setDetailError('')
    try {
      const response = await api.submit({ ...headers(), scope: selectedScope, prompt: normalized, client_idempotency_key: idempotencyKey })
      if (pendingSubmitKeyRef.current?.key === idempotencyKey) pendingSubmitKeyRef.current = null
      const result = unwrap<Dict>(response)
      setActiveInteractionId(result.interaction_id); setStatus(result.state ? stateLabel(result.state) : '请求已提交')
      if (recipe === 'qa' && promptRef.current.trim() === normalized) setPrompt('')
      refresh()
    } catch (error) { setStatus(error instanceof PublicResponseError ? error.message : '请求未提交，请再次点击重试') }
    finally { submitLockRef.current = false; setSubmitPending(false) }
  }
  const cancel = async () => {
    if (!activeInteractionId || cancelLocksRef.current.has(activeInteractionId) || !['pending', 'running'].includes(state || '')) return
    const interactionId = activeInteractionId
    cancelLocksRef.current.add(interactionId)
    setCancelPendingInteractionId(interactionId); setStatus('正在请求取消…')
    try {
      const result = unwrap<Dict>(await api.cancel({ ...headers(), interaction_id: interactionId }))
      const message = stateLabel(result.state)
      interactionStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setStatus(message)
      if (activeInteractionRef.current === interactionId) {
        void loadDetail(interactionId)
        refresh()
      } else {
        void loadHistory(true)
      }
    } catch (error) {
      const message = error instanceof PublicResponseError ? error.message : '取消请求未完成，请等待交互状态更新'
      interactionStatusRef.current.set(interactionId, message)
      if (activeInteractionRef.current === interactionId) setStatus(message)
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
    setExportPendingInteractionId(interactionId); setStatus('正在准备导出交互 JSON…')
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

  return <div className="agent-shell">
    <header className="agent-titlebar" id="titlebar" ref={titlebar}><div><strong>Agent Bar</strong><span>围绕已提交字幕提出一次请求</span></div><div className="title-actions"><span className="status" role="status" aria-live="polite">{status}</span><button className="close-button" type="button" onClick={() => api.close?.()} aria-label="关闭 Agent Bar">关闭</button></div></header>
    <main className="agent-layout">
      <aside className="scope-panel" aria-label="终态会话范围"><div className="panel-heading"><div><h1>终态会话</h1><p>{scopePending ? '正在读取…' : scopes.length ? `已显示 ${scopes.length} 个会话` : '暂无可用会话'}</p></div><button type="button" onClick={refresh} disabled={scopePending || historyPending}>刷新</button></div>{scopeError && <p className="error" role="alert">{scopeError}</p>}<div className="scope-list" role="list">{scopes.map((item) => <button type="button" role="listitem" className="scope-card" aria-current={item.scope.reference === selectedScope?.reference} key={scopeIdentity(item.scope)} onClick={() => selectScope(item.scope)}><strong>{utcLabel(item.ended_at)}</strong><span>{item.display_name}</span></button>)}{!scopePending && scopes.length === 0 && !scopeError && <p className="empty">完成一场终态会话后，它会出现在这里。</p>}</div>{scopeCursor && <button className="more-button" type="button" onClick={() => void loadScopes(false)} disabled={scopePending}>加载更多</button>}</aside>
      <section className="request-panel" aria-label="Agent 请求"><div className="selected-scope">{selected ? <><span>当前范围</span><strong>{selected.display_name}</strong></> : <span>请选择一个终态会话</span>}</div><div className={`eligibility ${eligibility === 'ready' ? 'ready' : ''}`} role="status">{eligibility ? eligibilityLabel(eligibility) : (selected ? '正在读取资格…' : '选择范围后读取资格')}</div><label className="prompt-label" htmlFor="agentPrompt">会话问答</label><textarea id="agentPrompt" value={prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder="例如：这场会的关键决定是什么？" disabled={busy || eligibility !== 'ready'} /><div className="request-actions"><button type="button" className="primary" data-action="minutes" disabled={busy || eligibility !== 'ready'} onClick={() => void submit('请基于这场终态会话生成会后结构化纪要，包含概要、结论、待办和风险。', 'minutes')}>生成纪要</button><button type="button" data-action="qa" disabled={!canSubmit} onClick={() => void submit(prompt, 'qa')}>提交问答</button></div>{activeInteractionId && <div className="run-card" aria-label="当前交互状态"><div><span>当前交互</span><strong>{stateLabel(state)}</strong></div><button type="button" onClick={() => void cancel()} disabled={cancelPending || !['pending', 'running'].includes(state || '')}>{cancelPending ? '正在取消…' : '取消'}</button></div>}{detailError && <p className="error" role="alert">{detailError}</p>}{detailPending && <p className="loading">正在读取结果…</p>}{detail && <article className="result-card" aria-label="交互结果"><header><div><span>{recipeLabel(detail.recipe_id)}</span><strong>{stateLabel(detail.state)}</strong></div><small>{utcLabel(detail.terminal_at ? new Date(detail.terminal_at).toISOString() : null)} · {detail.duration_ms} ms · {usageLabel(detail.usage, detail.usage_state)}</small></header>{detail.state === 'failed' && <p className="error" role="alert">{errorCodeLabel(detail.error_code)}</p>}{detail.result === null ? <p className="empty">该交互没有结果正文。</p> : resultSections(detail.result).map((section) => <section key={section.label}><h2>{section.label}</h2><p>{section.value}</p></section>)}{state === 'succeeded' && typeof detail.result_digest === 'string' && <section className="signal-actions" aria-label="交互反馈"><h2>交互反馈</h2><label htmlFor="agentEdit">编辑结果</label><textarea id="agentEdit" value={editText} maxLength={EDIT_LIMIT} onChange={(event) => updateEditText(event.target.value)} placeholder="输入你确认的结果版本" disabled={busy} /><div className="signal-buttons"><button type="button" data-signal="edit" onClick={() => void recordSignal('edit', { text: editText.trim() })} disabled={signalPending || editText.trim().length === 0}>提交编辑</button><button type="button" data-signal="accept" onClick={() => void recordSignal('accept')} disabled={signalPending}>接受</button><button type="button" data-signal="reject" onClick={() => void recordSignal('reject')} disabled={signalPending}>拒绝</button><button type="button" data-signal="remember" onClick={() => void recordSignal('remember')} disabled={signalPending}>记住</button><button type="button" data-signal="forget" onClick={() => void recordSignal('forget')} disabled={signalPending}>忘记</button></div>{signalStatus && <p className="signal-status" role="status">{signalStatus}</p>}</section>}<footer><span>来源引用 {sourceCount(detail)} 条</span><span>{detail.model?.provider_kind === 'cloud' ? '云端模型' : '本地模型'} · 模型身份已冻结</span><span className="export-privacy">导出内容可能包含字幕或个人上下文</span><button type="button" onClick={() => void exportInteraction()} disabled={exportPending || !['succeeded', 'failed', 'cancelled'].includes(state || '')}>{exportPending ? '正在导出…' : '导出交互 JSON'}</button></footer>{Array.isArray(detail.tool_calls) && detail.tool_calls.length > 0 && <details className="tool-audit"><summary>工具调用记录（{detail.tool_calls.length} 条）</summary><ol>{detail.tool_calls.map((call: Dict, index: number) => <li key={`${call.attempt}-${call.call_order}-${index}`}><div className="tool-call-heading"><span>{call.tool_name === 'search_context' ? '检索个人上下文' : call.tool_name === 'read_sources' ? '读取来源' : '受控工具'}</span><strong>{call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'cancelled' ? '已取消' : '处理中'}</strong>{call.status === 'failed' && <span>{errorCodeLabel(call.error_code)}</span>}</div><details className="tool-call-detail"><summary>查看参数与返回</summary><div><span>参数</span><pre>{JSON.stringify(call.args, null, 2)}</pre></div><div><span>返回</span><pre>{call.result === null ? '无返回值' : JSON.stringify(call.result, null, 2)}</pre></div></details></li>)}</ol></details>}</article>}</section>
      <aside className="history-panel" aria-label="Agent 交互历史"><div className="panel-heading"><div><h1>交互历史</h1><p>{historyPending ? '正在读取…' : `${history.length} 条终态交互`}</p></div></div>{historyError && <p className="error" role="alert">{historyError}</p>}{comparisonGroups(history).map((group) => <section className="comparison-card" aria-label="同一范围与输入的模型比较" key={group[0].comparison_group_id}><h2>模型比较</h2><p>同一范围与输入的不同模型结果</p><ul>{group.map((item) => <li key={item.interaction_id}><strong>{modelLabel(item.model)}</strong><span>{usageLabel(item.usage, item.usage_state)}</span><span>{relativeDuration(group, item)}</span></li>)}</ul></section>)}<div className="history-list" role="list">{history.map((item) => <button type="button" role="listitem" className="history-card" aria-current={item.interaction_id === activeInteractionId} key={item.interaction_id} onClick={() => setActiveInteractionId(item.interaction_id)}><strong>{recipeLabel(item.recipe_id)}</strong><span>{modelLabel(item.model)}</span><span>{utcLabel(item.terminal_at ? new Date(item.terminal_at).toISOString() : null)} · {stateLabel(item.terminal_reason)}</span><p>{resultPreview(item.result)}</p></button>)}{!historyPending && history.length === 0 && !historyError && <p className="empty">还没有终态 Agent 交互。</p>}</div>{historyCursor && <button className="more-button" type="button" onClick={() => void loadHistory(false)} disabled={historyPending}>加载更多</button>}</aside>
    </main>
  </div>
}
