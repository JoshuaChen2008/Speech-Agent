import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { MemorySources } from '../ui/shared/memory-sources'
import { PersonalMemoryFilePane } from './personal-memory-file-pane'

type Dict = Record<string, any>
type Resource = 'personal_memories' | 'session_episodes'
type ScopeKind = 'global' | 'session' | 'topic' | 'project'
type FieldError = { field: 'remember' | 'update', itemId?: string, message: string }

const CONTRACT_HEADER = Object.freeze({
  contract_id: 'speech-agent.personal-context.ui',
  contract_version: '1.2.0'
})
const MEMORY_KINDS = [
  ['decision', '决定'], ['conclusion', '结论'], ['todo', '待办'], ['term', '术语'],
  ['preference', '偏好'], ['project_fact', '项目事实'], ['experience', '经历']
] as const
const SCOPE_LABELS: Record<ScopeKind, string> = {
  global: '所有会话', session: '会话', topic: '主题', project: '项目'
}
const SOURCE_LABELS: Record<string, string> = {
  interaction: '助手问答', session: '已结束的会话'
}

function requestId (counter: { current: number }): string {
  counter.current += 1
  return `context.${counter.current}`
}

function errorMessage (response: Dict): string {
  const code = response?.error?.code || response?.code
  if (code === 'AGENT_CONTEXT_REVISION_CONFLICT') return '记忆已在其他地方修改，本次未保存。请刷新记忆后再试。'
  if (code === 'AGENT_CONTEXT_PERMISSION_DENIED') return '当前窗口没有修改记忆的权限。'
  if (code === 'AGENT_CONTEXT_REQUEST_INVALID') return '记忆内容或设置不符合要求，请检查后重试。'
  if (code === 'AGENT_CONTEXT_NOT_FOUND') return '这条个人记忆已不存在，请重新载入。'
  if (response instanceof Error || typeof response?.message === 'string') return '暂时无法读取记忆，请稍后重试。'
  return '暂时无法读取记忆，请稍后重试。'
}

function utf8ByteLength (value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function memoryTextError (value: string, label: string): string {
  const text = value.trim()
  if (text === '') return `${label}不能为空。`
  if (utf8ByteLength(text) > 2048) return `${label}过长，请缩短（上限为 2048 个 UTF-8 字节，不等于 2048 个字）。`
  return ''
}

function parseScope (value: string): { kind: ScopeKind, reference: string | null } {
  const [kind, ...rest] = value.split(':')
  const valid = (['global', 'session', 'topic', 'project'] as string[]).includes(kind) ? kind as ScopeKind : 'global'
  return { kind: valid, reference: valid === 'global' ? null : (rest.join(':') || null) }
}

function scopeText (scope: Dict): string {
  return scope?.label || SCOPE_LABELS[scope?.kind as ScopeKind] || '范围未知'
}

function timestampText (value: unknown): string {
  if (typeof value !== 'string') return '更新时间未知'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? `更新 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}` : '更新时间未知'
}

function offsetText (from: unknown, through: unknown): string {
  const start = Number(from); const end = Number(through)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return '发生时间范围未知'
  const seconds = (value: number) => `${Math.floor(value / 60000)}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}`
  return `发生 ${seconds(start)}–${seconds(end)}`
}

function memoryAccessibleLabel (item: Dict): string {
  const kind = MEMORY_KINDS.find(([value]) => value === item.kind)?.[1] || item.kind
  const origin = item.origin === 'explicit' ? '已确认内容' : '自动推断'
  return `个人记忆：${item.display_text}；范围：${scopeText(item.scope)}；类型：${kind}；来源：${origin}`
}

function episodeAccessibleLabel (item: Dict): string {
  const source = SOURCE_LABELS[item.source_kind] || item.source_kind
  return `会话要点：${item.summary?.title || '无标题'}；来源范围：${scopeText(item.scope)}；来源类型：${source}；${offsetText(item.occurred_from_offset_ms, item.occurred_through_offset_ms)}`
}

function ProcessingControl ({ snapshot, pending, onToggle }: {
  snapshot: Dict, pending: boolean, onToggle: (enabled: boolean, trigger: HTMLInputElement) => void
}): ReactElement {
  const processing = snapshot?.memory_processing
  const enabled = processing?.state === 'enabled'
  return <div className="group agent-context-processing" aria-label="个人记忆处理状态" aria-busy={pending}>
    <div className="row">
      <div><div className="label">添加和使用记忆</div>
        <div className="hint">{enabled
          ? '已开启，只处理新内容；重新开启后不会补充处理暂停期间或更早的内容。'
          : '已暂停，不再添加或引用记忆；已有内容保留在这里。'}</div></div>
      <label className="switch"><input type="checkbox" aria-label="添加和使用记忆" aria-busy={pending} checked={enabled}
        disabled={pending} onChange={(event) => onToggle(event.currentTarget.checked, event.currentTarget)} /><span>{enabled ? '已开启' : '已暂停'}</span></label>
    </div>
  </div>
}

function ProcessingConfirmation ({ enabled, trigger, onConfirm, onCancel }: {
  enabled: boolean, trigger: HTMLInputElement | null, onConfirm: () => void, onCancel: () => void
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef(onCancel)
  const triggerRef = useRef(trigger)
  cancelRef.current = onCancel
  useEffect(() => {
    const first = dialogRef.current?.querySelector('button') as HTMLButtonElement | null
    first?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelRef.current() } }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      triggerRef.current?.focus()
    }
  }, [])
  return <div className="agent-context-confirm" ref={dialogRef} role="alertdialog" aria-modal="true" aria-label={enabled ? '确认重新开启添加和使用记忆' : '确认暂停记忆'}>
    <strong>{enabled ? '重新开启添加和使用记忆？' : '暂停添加和使用记忆？'}</strong>
    <p>{enabled
      ? '重新开启后只处理新内容，不会补充处理暂停期间或更早的内容。'
      : '已暂停，不再添加或引用记忆；已有内容保留在这里。'}</p>
    <div className="agent-context-item-actions"><button className="primary-btn" type="button" onClick={onConfirm}>确认</button>
      <button className="secondary-btn" type="button" onClick={onCancel}>取消</button></div>
  </div>
}

function MemoryItem ({ item, busy, editing, editText, editKind, editScope, scopeItems, onEditKind, onEditScope, onConfirm, onSource, onEditStart, onEditText, onUpdate, onForget, onDelete, confirmAction, onConfirmCancel, rowError, editError }: {
  item: Dict, busy: boolean, editing: boolean, editText: string,
  editKind: string, editScope: string, scopeItems: Dict[], onEditKind: (kind: string) => void, onEditScope: (scope: string) => void, onConfirm: () => void, onSource: (target: Dict) => void,
  onEditStart: () => void, onEditText: (text: string) => void, onUpdate: () => void,
  onForget: () => void, onDelete: () => void, confirmAction: 'forget' | 'delete' | null,
  onConfirmCancel: () => void, rowError: string, editError: string
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const hadDialog = useRef(false)
  const focusAfterBusy = useRef(false)
  useEffect(() => {
    if (confirmAction) {
      hadDialog.current = true
      const first = dialogRef.current?.querySelector('button') as HTMLButtonElement | null
      first?.focus()
      const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onConfirmCancel() } }
      document.addEventListener('keydown', onKeyDown)
      return () => document.removeEventListener('keydown', onKeyDown)
    }
    if (hadDialog.current) {
      hadDialog.current = false
      if (busy) focusAfterBusy.current = true
      else triggerRef.current?.focus()
    }
    if (!busy && focusAfterBusy.current) {
      focusAfterBusy.current = false
      triggerRef.current?.focus()
    }
    return undefined
  }, [confirmAction, onConfirmCancel, busy])
  return <article className="agent-context-item" data-memory-id={item.memory_id} aria-label={memoryAccessibleLabel(item)} aria-busy={busy}>
    {editing
      ? <textarea aria-label="修改个人记忆" value={editText} disabled={busy}
        onChange={(event) => onEditText(event.currentTarget.value)} />
      : <div className="agent-context-item-text">{item.display_text}</div>}
    {editing && editError !== '' && <p className="settings-status" role="alert">{editError}</p>}
    {editing && <div className="agent-context-form-row">
      <select aria-label="修改记忆类型" value={editKind} disabled={busy} onChange={(event) => onEditKind(event.currentTarget.value)}>{MEMORY_KINDS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
      <select aria-label="修改记忆范围" value={editScope} disabled={busy} onChange={(event) => onEditScope(event.currentTarget.value)}><option value="global:">所有会话</option>{scopeItems.map((scope) => <option key={scope.scope_id} value={`${scope.kind}:${scope.scope_id}`}>{scope.display_name}</option>)}</select>
    </div>}
    <button className="link-btn agent-context-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? '收起详情' : '展开详情'}</button>
    {expanded && <div className="agent-context-item-meta">
        <span>{MEMORY_KINDS.find(([kind]) => kind === item.kind)?.[1] || item.kind}</span>
        <span>{scopeText(item.scope)}</span>
        <span>{item.origin === 'explicit' ? '已确认' : '待确认'}</span>
        <span>{item.lifecycle === 'forgotten' ? '已停用，不再引用' : item.lifecycle === 'conflicted' ? '需要核对' : ''}</span>
        <span>{timestampText(item.updated_at)}</span>
      </div>}
    {expanded && <MemorySources sources={item.sources} onOpen={onSource} />}
    <div className="agent-context-item-actions">
      {!editing && item.origin === 'inferred' && <button className="primary-btn" type="button" disabled={busy} onClick={onConfirm}>确认记忆</button>}
      {editing
        ? <button className="primary-btn" type="button" disabled={busy || editText.trim() === ''} onClick={onUpdate}>保存修改</button>
        : <button className="secondary-btn" type="button" disabled={busy} onClick={() => { setExpanded(true); onEditStart() }}>修改</button>}
      <button className="secondary-btn" type="button" aria-label={`停止使用个人记忆：${item.display_text}`} disabled={busy || item.lifecycle === 'forgotten'} onClick={(event) => { triggerRef.current = event.currentTarget; onForget() }}>停止使用</button>
      <button className="secondary-btn danger-btn" type="button" aria-label={`删除个人记忆：${item.display_text}`} disabled={busy} onClick={(event) => { triggerRef.current = event.currentTarget; onDelete() }}>删除</button>
    </div>
    {rowError !== '' && <p className="settings-status" role="alert">{rowError}</p>}
    {confirmAction && <div className="agent-context-confirm" ref={dialogRef} role="alertdialog" aria-modal="true" aria-label={confirmAction === 'delete' ? '确认删除个人记忆' : '确认停止使用个人记忆'}>
      <strong>{confirmAction === 'delete' ? '确认删除这条个人记忆？' : '停止使用这条记忆？'}</strong>
      <p>{confirmAction === 'delete'
        ? '删除这条记忆及其修改记录和来源信息。不会从相同的旧来源自动重新生成。'
        : '助手将不再引用这条记忆。内容、来源和会话要点仍会保留，也不会自动恢复使用。'}</p>
      <div className="agent-context-item-actions"><button className="primary-btn" type="button" disabled={busy} onClick={confirmAction === 'delete' ? onDelete : onForget}>确认</button>
        <button className="secondary-btn" type="button" disabled={busy} onClick={onConfirmCancel}>取消</button></div>
    </div>}
  </article>
}

function EpisodeItem ({ item, onSource }: { item: Dict, onSource: (target: Dict) => void }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return <article className="agent-context-item" data-episode-id={item.episode_id} aria-label={episodeAccessibleLabel(item)}>
    <div className="agent-context-item-text">{item.summary?.title}</div>
    <button className="link-btn agent-context-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? '收起详情' : '展开详情'}</button>
    {expanded && <><ul className="agent-context-bullets">{(item.summary?.bullets || []).map((bullet: string) => <li key={bullet}>{bullet}</li>)}</ul>
      <div className="agent-context-item-meta">
        <span>{SOURCE_LABELS[item.source_kind] || item.source_kind}</span>
        <span>{scopeText(item.scope)}</span>
        <span>{offsetText(item.occurred_from_offset_ms, item.occurred_through_offset_ms)}</span>
        <span>{timestampText(item.updated_at)}</span>
        {item.omissions?.map((omission: string) => <span key={omission}>省略：{omission === 'not_committed_tail' ? '尚未保存的末尾内容' : '处理容量限制'}</span>)}
      </div><MemorySources sources={item.sources} onOpen={onSource} />
      {(item.associations || []).map((association: Dict) => <p key={association.memory_id}>相关会话背景：{association.relation}；依据：{association.match_keys.join('、')}</p>)}</>}
  </article>
}

export function AgentContextPane ({ shell }: { shell: Dict }): ReactElement {
  const [snapshot, setSnapshot] = useState<Dict | null>(null)
  const [resource, setResource] = useState<Resource>('personal_memories')
  const [pages, setPages] = useState<Record<Resource, Dict | null>>({ personal_memories: null, session_episodes: null })
  const [loading, setLoading] = useState(true)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [requiresReload, setRequiresReload] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{ itemId: string, type: 'forget' | 'delete' } | null>(null)
  const [retryRead, setRetryRead] = useState<{ resource: Resource, cursor: string | null } | null>(null)
  const [rowErrorId, setRowErrorId] = useState<string | null>(null)
  const [processingConfirmation, setProcessingConfirmation] = useState<boolean | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editKind, setEditKind] = useState('term')
  const [editScope, setEditScope] = useState('global:')
  const [overviewMode, setOverviewMode] = useState(true)
  const [overviewScope, setOverviewScope] = useState('global')
  const [rememberText, setRememberText] = useState('')
  const [rememberKind, setRememberKind] = useState('term')
  const [rememberScope, setRememberScope] = useState('global:')
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const requestCounter = useRef({ current: 0 })
  const revisionRef = useRef<number>(-1)
  const resourceRef = useRef<Resource>(resource)
  const pageRequestRef = useRef<Record<Resource, number>>({ personal_memories: 0, session_episodes: 0 })
  const refreshGenerationRef = useRef(0)
  const processingTriggerRef = useRef<HTMLInputElement | null>(null)
  const focusProcessingAfterPendingRef = useRef(false)
  resourceRef.current = resource

  const readPage = useCallback(async (nextResource: Resource, cursor: string | null = null) => {
    const requestSequence = pageRequestRef.current[nextResource] + 1
    pageRequestRef.current[nextResource] = requestSequence
    let response: Dict
    try {
      response = await shell.manageAgentContext({
        ...CONTRACT_HEADER,
        request_id: requestId(requestCounter.current),
        command: { type: 'view', resource: nextResource, limit: 20, cursor }
      })
    } catch (error) {
      if (requestSequence !== pageRequestRef.current[nextResource] || resourceRef.current !== nextResource) return
      throw error
    }
    if (response?.ok !== true) {
      if (requestSequence !== pageRequestRef.current[nextResource] || resourceRef.current !== nextResource) return
      throw response
    }
    if (requestSequence !== pageRequestRef.current[nextResource] || (Number.isInteger(response.revision) && response.revision < revisionRef.current)) return
    setPages((current) => {
      const previous = cursor === null ? null : current[nextResource]
      const previousItems = Array.isArray(previous?.items) ? previous.items : []
      const incomingItems = Array.isArray(response.result?.items) ? response.result.items : []
      const idOf = (item: Dict) => nextResource === 'personal_memories' ? item.memory_id : item.episode_id
      const merged = cursor === null ? incomingItems : [...previousItems, ...incomingItems.filter((item: Dict) => !previousItems.some((old: Dict) => idOf(old) === idOf(item)))]
      return { ...current, [nextResource]: { ...response.result, items: merged } }
    })
    if (Number.isInteger(response.revision) && response.revision >= revisionRef.current) {
      revisionRef.current = response.revision
      setSnapshot((current) => current ? { ...current, revision: response.revision } : current)
    }
    if (resourceRef.current === nextResource) setRetryRead(null)
  }, [shell])

  const refresh = useCallback(async (showLoading = false, clearNotice = true) => {
    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    if (showLoading) setLoading(true)
    try {
      const overview = await shell.getAgentContextOverview({ ...CONTRACT_HEADER, ...(overviewScope !== 'global' ? { scope_key: overviewScope } : {}) })
      if (overview?.ok !== true) throw overview
      if (generation !== refreshGenerationRef.current) return
      if (Number.isInteger(overview.snapshot.revision) && overview.snapshot.revision < revisionRef.current) return
      revisionRef.current = overview.snapshot.revision
      setSnapshot(overview.snapshot)
      await readPage(resourceRef.current)
      if (generation !== refreshGenerationRef.current) return
      if (clearNotice) setNotice('')
    } catch (error) {
      if (generation !== refreshGenerationRef.current) return
      setSnapshot(null)
      setNotice(errorMessage(error as Dict))
    } finally { if (showLoading && generation === refreshGenerationRef.current) setLoading(false) }
  }, [readPage, shell, overviewScope])

  useEffect(() => {
    let disposed = false
    const unsubscribe = typeof shell.onAgentContextChanged === 'function'
      ? shell.onAgentContextChanged((event: Dict) => {
        if (disposed || !Number.isInteger(event?.revision) || event.revision < revisionRef.current) return
        void refresh(false)
      })
      : null
    void refresh(true)
    return () => { disposed = true; if (typeof unsubscribe === 'function') unsubscribe() }
  }, [refresh, shell])

  const runCommand = async (command: Dict, key = 'context') => {
    if (!snapshot || pendingKey !== null) return false
    setPendingKey(key)
    try {
      const requestCommand = { ...command, expected_revision: revisionRef.current }
      const response = await shell.manageAgentContext({
        ...CONTRACT_HEADER,
        request_id: requestId(requestCounter.current),
        command: requestCommand
      })
      if (response?.ok !== true) {
        const nextAction = response?.error?.next_action
        setRequiresReload(nextAction === 'reload' || nextAction === 'retry')
        setRowErrorId(key.startsWith('memory:') ? key.slice('memory:'.length) : null)
        if (response?.error?.code === 'AGENT_CONTEXT_REQUEST_INVALID') {
          const message = command.type === 'update'
            ? '修改个人记忆内容或范围无效，请检查对应字段。'
            : command.type === 'remember'
              ? '记住个人记忆内容、类型或范围无效，请检查对应字段。'
              : errorMessage(response)
          if (command.type === 'update') setFieldError({ field: 'update', itemId: key.slice('memory:'.length), message })
          if (command.type === 'remember') setFieldError({ field: 'remember', message })
          setNotice(message)
        } else {
          setFieldError(null)
          setNotice(errorMessage(response))
        }
        return false
      }
      revisionRef.current = response.revision
      setRequiresReload(false)
      setRowErrorId(null)
      setFieldError(null)
      const deletion = command.type === 'delete' ? response.result?.deleted : null
      const deletionCounts = deletion
        ? `条目 ${deletion.items}、修改历史 ${deletion.revisions}、来源引用 ${deletion.evidence}`
        : ''
      setNotice(command.type === 'set_processing'
        ? (command.state === 'enabled' ? '已重新开启添加和使用记忆。' : '已暂停添加和使用记忆，已有内容保留。')
        : command.type === 'delete'
          ? response.result?.replayed === true
            ? `这条个人记忆已经删除。`
            : `这条个人记忆已删除：${deletionCounts}。`
          : '记忆已更新。')
      setEditingId(null)
      await refresh(false, false)
      return true
    } catch (error) { setFieldError(null); setNotice(errorMessage(error as Dict)); setRequiresReload(true); return false }
    finally { setPendingKey(null) }
    return false
  }

  useEffect(() => {
    if (pendingKey === null && focusProcessingAfterPendingRef.current) {
      focusProcessingAfterPendingRef.current = false
      processingTriggerRef.current?.focus()
    }
  }, [pendingKey])

  const remember = async () => {
    const textError = memoryTextError(rememberText, '个人记忆内容')
    if (textError !== '') {
      setFieldError({ field: 'remember', message: textError })
      setNotice(textError)
      return
    }
    setFieldError(null)
    const scope = parseScope(rememberScope)
    const succeeded = await runCommand({
      type: 'remember',
      entry: { display_text: rememberText.trim(), kind: rememberKind, scope }
    }, 'remember')
    if (succeeded) setRememberText('')
  }

  const memories = pages.personal_memories?.items || []
  const episodes = pages.session_episodes?.items || []
  const selectedPage = resource === 'personal_memories' ? memories : episodes
  const scopeItems = snapshot?.scope_directory?.items || []
  const nextCursor = pages[resource]?.next_cursor || null
  const openSource = (target: Dict) => {
    if (typeof shell.openAgentContextSource !== 'function') { setNotice('暂时无法打开来源记录，请重试。'); return }
    void shell.openAgentContextSource(target).then((result: Dict) => { if (!result.ok) setNotice(result.code === 'AGENT_CONTEXT_NOT_FOUND' ? '来源记录已删除。' : '暂时无法打开来源记录，请重试。') }).catch(() => setNotice('暂时无法打开来源记录，请重试。'))
  }
  const editOverviewMemory = async (memoryId: string) => {
    try {
      const response = await shell.manageAgentContext({ ...CONTRACT_HEADER, request_id: requestId(requestCounter.current), command: { type: 'view_item', item_id: memoryId } })
      if (!response.ok || response.revision < revisionRef.current) throw response
      const item = response.result.items[0]
      revisionRef.current = response.revision
      setSnapshot((current) => current ? { ...current, revision: response.revision } : current)
      setPages((current) => ({ ...current, personal_memories: { ...current.personal_memories, items: [...(current.personal_memories?.items || []).filter((old: Dict) => old.memory_id !== memoryId), item] } }))
      setEditingId(memoryId); setEditText(item.display_text); setEditKind(item.kind); setEditScope(`${item.scope.kind}:${item.scope.reference || ''}`)
    } catch (error) { setNotice(errorMessage(error as Dict)) }
  }
  const overview = snapshot?.overview

  if (loading && !snapshot) return <section className="agent-context-pane"><h1>我的记忆</h1><p className="sub">正在读取记忆。</p></section>
  if (!snapshot) return <section className="agent-context-pane"><h1>我的记忆</h1><p className="sub">暂时无法读取记忆。</p><p className="settings-status" role="alert">{notice}</p><button className="secondary-btn" type="button" onClick={() => void refresh(true)}>重试</button></section>

  return <section className="agent-context-pane" aria-labelledby="agentContextTitle">
    <h1 id="agentContextTitle">我的记忆</h1>
    <PersonalMemoryFilePane scopes={scopeItems} />
    <p className="sub">查看偏好、本人背景、目标和相关会话。自动整理的记忆需要你确认，也可以直接修改。</p>
    {notice !== '' && <div className="agent-context-notice"><p className="settings-status" role={requiresReload || fieldError !== null ? 'alert' : 'status'} aria-live="polite">{notice}</p>
      {requiresReload && <button className="secondary-btn" type="button" onClick={() => { setRequiresReload(false); setRowErrorId(null); void refresh(true) }}>刷新记忆</button>}
      {!requiresReload && retryRead && <button className="secondary-btn" type="button" onClick={() => { const request = retryRead; void readPage(request.resource, request.cursor).catch((error) => { if (resourceRef.current !== request.resource) return; setRetryRead(request); setNotice(errorMessage(error)) }) }}>重试读取</button>}</div>}
    <ProcessingControl snapshot={snapshot} pending={pendingKey === 'processing' || processingConfirmation !== null}
      onToggle={(enabled, trigger) => { processingTriggerRef.current = trigger; setProcessingConfirmation(enabled) }} />
    {processingConfirmation !== null && <ProcessingConfirmation enabled={processingConfirmation}
      trigger={processingTriggerRef.current}
      onConfirm={() => { const enabled = processingConfirmation; focusProcessingAfterPendingRef.current = true; setProcessingConfirmation(null); void runCommand({ type: 'set_processing', state: enabled ? 'enabled' : 'suspended' }, 'processing') }}
      onCancel={() => setProcessingConfirmation(null)} />}
    <div className="agent-context-tabs" role="radiogroup" aria-label="记忆类别">
      <button type="button" role="radio" className={resource === 'personal_memories' && overviewMode ? 'on' : ''} aria-checked={resource === 'personal_memories' && overviewMode} onClick={() => { setOverviewMode(true); setResource('personal_memories'); resourceRef.current = 'personal_memories'; void readPage('personal_memories').catch((error) => setNotice(errorMessage(error))) }}>记忆概览</button>
      <button type="button" role="radio" aria-checked={resource === 'personal_memories' && !overviewMode} className={resource === 'personal_memories' && !overviewMode ? 'on' : ''}
        onClick={() => { setOverviewMode(false); resourceRef.current = 'personal_memories'; setResource('personal_memories'); const request = { resource: 'personal_memories' as Resource, cursor: null }; void readPage(request.resource, request.cursor).catch((error) => { if (resourceRef.current !== request.resource) return; setRetryRead(request); setNotice(errorMessage(error)) }) }}>个人记忆（{snapshot.counts.personal_memories}）</button>
      <button type="button" role="radio" aria-checked={resource === 'session_episodes'} className={resource === 'session_episodes' ? 'on' : ''}
        onClick={() => { setOverviewMode(false); resourceRef.current = 'session_episodes'; setResource('session_episodes'); const request = { resource: 'session_episodes' as Resource, cursor: null }; void readPage(request.resource, request.cursor).catch((error) => { if (resourceRef.current !== request.resource) return; setRetryRead(request); setNotice(errorMessage(error)) }) }}>会话要点（{snapshot.counts.session_episodes}）</button>
    </div>
    {resource === 'personal_memories' && overviewMode && <div aria-label="记忆概览">
      <label>概览范围 <select aria-label="概览范围" value={overviewScope} onChange={(event) => setOverviewScope(event.currentTarget.value)}><option value="global">全部个人记忆</option>{scopeItems.filter((scope: Dict) => ['project', 'topic'].includes(scope.kind)).map((scope: Dict) => <option key={scope.scope_id} value={scope.scope_id}>{scope.display_name}</option>)}</select></label>
      <p role="status">{overview?.state === 'updating' ? '正在更新概览，下面仍可查看和修改记忆条目。' : overview?.state === 'failed' ? '暂时无法更新概览，保留仍有效的上次内容。' : overview?.state === 'stale' ? '记忆已有变化，概览等待更新；已撤销的内容不会继续显示。' : overview?.current ? '概览依据当前条目和相关会话生成。' : '先按实际条目查看记忆；有新内容时会在后台生成概览。'}</p>
      {overview?.state === 'failed' && snapshot.memory_processing.state === 'enabled' && <button className="secondary-btn" type="button" disabled={pendingKey !== null} onClick={() => void runCommand({ type: 'refresh_overview' }, 'overview')}>重试更新概览</button>}
      {(overview?.current?.sections || []).map((section: Dict, index: number) => <article className="agent-context-item" key={index}>
        <h2>{({ facts: '已确认内容', changes: '相关变化', candidates: '待确认记忆', conflicts: '需要核对' } as Dict)[section.category]} · {section.title}</h2><p>{section.text}</p>
        <MemorySources sources={overview.section_sources?.[index]} onOpen={openSource} />
        {section.memoryRefs.map((ref: Dict, refIndex: number) => <button className="secondary-btn" key={ref.memoryId} type="button" onClick={() => void editOverviewMemory(ref.memoryId)}>查看并修改来源记忆{section.memoryRefs.length > 1 ? ` ${refIndex + 1}` : ''}</button>)}
      </article>)}
      {overview?.current && <p className="hint">已整理 {overview.current.coverage.memories} 条记忆、{overview.current.coverage.episodes} 条相关会话。{overview.current.coverage.has_more ? '还有来源等待处理。' : ''}{overview.current.coverage.omissions.length > 0 ? '受处理容量限制，仅展示部分内容。' : ''}</p>}
      {overview?.previous?.sections.length > 0 && <details><summary>上次概览</summary>{overview.previous.sections.map((section: Dict, index: number) => <p key={index}>{section.text}</p>)}</details>}
    </div>}
    {resource === 'personal_memories' && <div className="group agent-context-remember">
      <div className="row"><div><div className="label">记住一条个人记忆</div><div className="hint">写下你希望助手记住的信息。</div></div></div>
      <textarea aria-label="记住个人记忆" aria-busy={pendingKey === 'remember'} value={rememberText} disabled={pendingKey === 'remember'} placeholder="输入要保留的事实、决定、术语或偏好"
        onChange={(event) => { setRememberText(event.currentTarget.value); if (fieldError?.field === 'remember') setFieldError(null) }} />
      {fieldError?.field === 'remember' && <p className="settings-status" role="alert">{fieldError.message}</p>}
      <div className="agent-context-form-row">
        <select aria-label="个人记忆类型" value={rememberKind} disabled={pendingKey === 'remember'} onChange={(event) => setRememberKind(event.currentTarget.value)}>
          {MEMORY_KINDS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
        </select>
        <select aria-label="个人记忆范围" value={rememberScope} disabled={pendingKey === 'remember'} onChange={(event) => setRememberScope(event.currentTarget.value)}>
          <option value="global:">所有会话</option>
          {scopeItems.map((item: Dict) => <option key={item.scope_id} value={`${item.kind}:${item.scope_id}`}>{item.display_name}</option>)}
        </select>
        <button className="primary-btn" type="button" aria-busy={pendingKey === 'remember'} disabled={pendingKey !== null || rememberText.trim() === ''} onClick={() => void remember()}>记住</button>
      </div>
    </div>}
    <div className="agent-context-list" aria-live="polite">
      {selectedPage.length === 0 && <p className="agent-context-empty">{resource === 'personal_memories' ? '还没有个人记忆。可以手动添加；助手也会按设置从提问中整理记忆，等你确认。' : '还没有会话要点。按记忆设置整理会话后，会显示在这里。'}</p>}
      {resource === 'personal_memories'
        ? [...memories].sort((a: Dict, b: Dict) => overviewMode ? Number(a.origin === 'inferred') - Number(b.origin === 'inferred') || a.kind.localeCompare(b.kind) : 0).map((item: Dict, index: number, items: Dict[]) => <div key={item.memory_id}>
          {overviewMode && (index === 0 || items[index - 1].origin !== item.origin) && <h2>{item.origin === 'inferred' ? '待确认记忆' : '已确认记忆'}</h2>}
          {overviewMode && (index === 0 || items[index - 1].kind !== item.kind || items[index - 1].origin !== item.origin) && <h3>{MEMORY_KINDS.find(([kind]) => kind === item.kind)?.[1]}</h3>}
          <MemoryItem item={item} busy={pendingKey === `memory:${item.memory_id}`} editing={editingId === item.memory_id}
          editKind={editKind} editScope={editScope} scopeItems={scopeItems} onEditKind={setEditKind} onEditScope={setEditScope} onSource={openSource}
          onConfirm={() => void runCommand({ type: 'update', item_id: item.memory_id, item_revision: item.revision, entry: { display_text: item.display_text, kind: item.kind, scope: { kind: item.scope.kind, reference: item.scope.reference } } }, `memory:${item.memory_id}`)}
          editText={editingId === item.memory_id ? editText : item.display_text}
          onEditStart={() => { setEditingId(item.memory_id); setEditText(item.display_text); setEditKind(item.kind); setEditScope(`${item.scope.kind}:${item.scope.reference || ''}`); setFieldError(null) }}
          onEditText={(text) => { setEditText(text); if (fieldError?.field === 'update' && fieldError.itemId === item.memory_id) setFieldError(null) }}
          onUpdate={() => {
            const textError = memoryTextError(editText, '修改后的个人记忆内容')
            if (textError !== '') { setFieldError({ field: 'update', itemId: item.memory_id, message: textError }); setNotice(textError); return }
            void runCommand({ type: 'update', item_id: item.memory_id, item_revision: item.revision, entry: { display_text: editText.trim(), kind: editKind, scope: parseScope(editScope) } }, `memory:${item.memory_id}`)
          }}
          onForget={() => { if (confirmAction?.itemId === item.memory_id && confirmAction?.type === 'forget') { setConfirmAction(null); void runCommand({ type: 'forget', item_id: item.memory_id, item_revision: item.revision }, `memory:${item.memory_id}`) } else setConfirmAction({ itemId: item.memory_id, type: 'forget' }) }}
          onDelete={() => { if (confirmAction?.itemId === item.memory_id && confirmAction?.type === 'delete') { setConfirmAction(null); void runCommand({ type: 'delete', item_id: item.memory_id, item_revision: item.revision, deletion_idempotency_key: `delete.${item.memory_id}.${item.revision}` }, `memory:${item.memory_id}`) } else setConfirmAction({ itemId: item.memory_id, type: 'delete' }) }}
          confirmAction={confirmAction?.itemId === item.memory_id ? confirmAction?.type ?? null : null}
          onConfirmCancel={() => setConfirmAction(null)}
          rowError={rowErrorId === item.memory_id ? notice : ''}
          editError={fieldError?.field === 'update' && fieldError.itemId === item.memory_id ? fieldError.message : ''} /></div>)
        : episodes.map((item: Dict) => <EpisodeItem key={item.episode_id} item={item} onSource={openSource} />)}
    </div>
    {pages[resource]?.has_more === true && <button className="secondary-btn" type="button" disabled={pendingKey !== null}
      onClick={() => { const request = { resource, cursor: nextCursor }; void readPage(request.resource, request.cursor).catch((error) => { if (resourceRef.current !== request.resource) return; setRetryRead(request); setNotice(errorMessage(error)) }) }}>读取更多</button>}
  </section>
}
