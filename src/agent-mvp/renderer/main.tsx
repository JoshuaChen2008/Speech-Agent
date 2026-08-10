import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../ui/shared/tokens.css'
import './styles.css'
import { Icon, IconName } from './icons'

type Session = { sessionId: string; sourceId: 'loopback' | 'mic'; state: string; startedAt: number }
type Job = { runId: string; state: string; errorCode: string | null; attemptCount: number; model: string }
type Artifact = { artifactId: string; runId: string; sessionId: string; type: string; content: { title: string; bullets: string[] } }
type Message = { messageId: string; role: string; content: Record<string, any> }
type State = { runtime: { sessions: Session[]; jobs: Job[]; artifacts: Artifact[]; runningRunId: string | null }; provider: any }
type Tone = 'neutral' | 'busy' | 'warn' | 'danger' | 'accent'
type StateView = { label: string; icon: IconName; tone: Tone }

/* 主视图槽位。今天只注册「对话」和「任务」两个视图；将来加视图是往槽位里注册，
   不需要动外壳。两个视图始终挂载、靠 CSS 切显隐（与设置窗 .pane 的做法一致），
   这样任务和产物在「对话」视图下依然存在于 DOM，不会因为切视图而丢状态。 */
type ViewId = 'chat' | 'runs'
/* 右栏永远只回答一件事：当前选中的是什么。选中项消失时 fail closed 回到会话。 */
type Selection = { kind: 'session' } | { kind: 'job'; runId: string } | { kind: 'artifact'; artifactId: string }

/* 文案原则：动作和状态说人话，技术事实照实给但配一句解释。
   ⚠ reference-output 必须始终显示为「参考结构化产物」或「参考产物」，
   不得改写成会后纪要、增强文本或个人记忆（docs/agent-ui-ux-handoff.md §5.2）。 */
const errorText: Record<string, string> = {
  AGENT_PROVIDER_AUTH_FAILED: '模型服务拒绝了密钥，请检查后重新保存。',
  AGENT_PROVIDER_TIMEOUT: '模型服务响应超时，可以稍后重试。',
  AGENT_PROVIDER_UNAVAILABLE: '暂时连不上模型服务。',
  AGENT_OUTPUT_INVALID: '模型返回的内容不符合固定格式，已丢弃。',
  AGENT_PERMISSION_DENIED: '这个请求超出了允许的能力范围。',
  AGENT_REQUEST_INVALID: '请求和已冻结的输入对不上，请重新发起。'
}

const JOB_STATES: Record<string, StateView> = {
  queued: { label: '排队中', icon: 'clock', tone: 'neutral' },
  running: { label: '进行中', icon: 'spin', tone: 'busy' },
  retry_wait: { label: '稍后重试', icon: 'retry', tone: 'warn' },
  succeeded: { label: '已完成', icon: 'check', tone: 'accent' },
  failed: { label: '失败', icon: 'close', tone: 'danger' },
  cancelled: { label: '已取消', icon: 'ban', tone: 'neutral' }
}
const SESSION_STATES: Record<string, string> = { closed: '正常结束', interrupted: '中途被打断' }
const MESSAGE_ROLES: Record<string, string> = {
  user: '你', assistant: 'AI', tool_preview: '任务确认', tool_confirmation: '你的决定', tool_result: '任务结果', status: '运行状态'
}
const MESSAGE_STATUS: Record<string, string> = {
  CHAT_STARTED: '本轮对话已开始。',
  CHAT_CANCELLED: '本轮对话已取消。',
  PROVIDER_UNAVAILABLE: '暂时连不上模型服务。'
}
const EVENT_TYPES: Record<string, string> = {
  agent_start: '开始处理', agent_end: '处理结束', turn_start: '新一轮', turn_end: '本轮结束',
  tool_execution_start: '开始使用工具', tool_execution_end: '工具用完', text_delta: '正在输出回答'
}
const BUSY_STATUS: Record<string, string> = {
  provider: '正在保存模型设置…',
  fixture: '正在新建测试会话…',
  chat: '正在等 AI 回答…',
  preview: '正在准备任务确认…',
  confirm: '正在提交你的决定…',
  cancel: '正在取消任务…'
}
const ACTIVE_JOB_STATES = ['queued', 'retry_wait', 'running']

/* 分栏尺寸：纯 renderer 本地偏好，不进任何契约，也不写入 SQLite。 */
const LAYOUT_KEY = 'agent-mvp.layout.v1'
const LIMITS = { left: [180, 420], right: [210, 460], detail: [130, 460], composer: [72, 280] } as const

function jobStateView (state: string): StateView { return JOB_STATES[state] || { label: `状态未知（${state}）`, icon: 'question', tone: 'warn' } }
function sessionStateLabel (state: string): string { return SESSION_STATES[state] || `状态未知（${state}）` }
function sourceLabel (sourceId: string): string { return sourceId === 'mic' ? '麦克风' : '系统声音' }
function sourceIcon (sourceId: string): IconName { return sourceId === 'mic' ? 'mic' : 'speaker' }
function eventLabel (type: string): string { return EVENT_TYPES[type] || type }
function shortId (value: string) { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value }
function clamp (value: number, [min, max]: readonly [number, number]) { return Math.min(max, Math.max(min, value)) }
const date = (value: number, full = false): string => new Intl.DateTimeFormat('zh-CN', full
  ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
  : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))

function messageBody (message: Message): string {
  const content = message.content
  if (message.role === 'user' || message.role === 'assistant') return content.text
  if (message.role === 'tool_preview') {
    return `任务类型 ${content.recipeId} · 读到第 ${content.inputRef.inputWatermark} 条 · 内容指纹 ${shortId(content.inputRef.inputDigest)}\n`
      + (content.cloudDisclosure ? '确认后会把这场会话的文字发到云端模型服务。' : '不会把文字发到云端。')
  }
  if (message.role === 'tool_confirmation') return content.decision === 'accepted' ? '你确认了执行。' : '你拒绝了执行，没有创建任务。'
  if (message.role === 'tool_result') {
    return `任务${jobStateView(content.state).label}` + (content.artifactId ? '，参考结构化产物已保存。' : '，没有产出内容。')
  }
  if (message.role === 'status') return MESSAGE_STATUS[content.code] || `运行状态 ${content.code}`
  return '这条记录的格式当前界面还不认识。'
}

/* 可拖拽分隔条。指针拖动 + 方向键，都带 role=separator 与 aria-valuenow。 */
function Splitter ({ axis, label, value, limits, invert = false, onChange, className }: {
  axis: 'x' | 'y'; label: string; value: number; limits: readonly [number, number]
  invert?: boolean; onChange: (next: number) => void; className: string
}) {
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const origin = value
    const start = axis === 'x' ? event.clientX : event.clientY
    const move = (moveEvent: PointerEvent) => {
      const delta = (axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - start
      onChange(clamp(origin + (invert ? -delta : delta), limits))
    }
    const end = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end)
      document.body.classList.remove('is-resizing')
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end)
  }
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const less = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const more = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== less && event.key !== more) return
    event.preventDefault()
    const step = (event.key === more ? 16 : -16) * (invert ? -1 : 1)
    onChange(clamp(value + step, limits))
  }
  return <div className={`splitter ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuenow={Math.round(value)} aria-valuemin={limits[0]} aria-valuemax={limits[1]}
    onPointerDown={begin} onKeyDown={key}><span className="splitter-grip" aria-hidden="true" /></div>
}

function App () {
  const [state, setState] = useState<State | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [events, setEvents] = useState<any[]>([])
  const [prompt, setPrompt] = useState('请说明这个隔离 Agent 内核读取了什么范围的上下文。')
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<any>({ provider: 'deterministic-test', baseUrl: '', model: 'fixture-model', cloudDisclosureAccepted: false, apiKey: '' })
  const [view, setView] = useState<ViewId>('chat')
  const [selection, setSelection] = useState<Selection>({ kind: 'session' })
  const [providerOpen, setProviderOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [layout, setLayout] = useState(() => {
    const fallback = { left: 244, right: 276, detail: 200, composer: 116 }
    try {
      const stored = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || 'null')
      if (!stored || typeof stored !== 'object') return fallback
      return {
        left: clamp(Number(stored.left) || fallback.left, LIMITS.left),
        right: clamp(Number(stored.right) || fallback.right, LIMITS.right),
        detail: clamp(Number(stored.detail) || fallback.detail, LIMITS.detail),
        composer: clamp(Number(stored.composer) || fallback.composer, LIMITS.composer)
      }
    } catch { return fallback }
  })
  const messageList = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previewPanel = useRef<HTMLElement>(null)
  const previewTrigger = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)

  const setPane = useCallback((key: keyof typeof LIMITS, next: number) => {
    setLayout((current) => {
      const updated = { ...current, [key]: next }
      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(updated)) } catch { /* 存不下就只在本次生效 */ }
      return updated
    })
  }, [])

  const refresh = async () => {
    const next = await window.agentMvp.getState(); setState(next)
    setForm({
      provider: next.provider.provider,
      baseUrl: next.provider.baseUrl,
      model: next.provider.model,
      cloudDisclosureAccepted: next.provider.cloudDisclosureAccepted,
      apiKey: ''
    })
    if (!selected && next.runtime.sessions[0]) setSelected(next.runtime.sessions[0].sessionId)
  }

  useEffect(() => {
    refresh().catch((cause) => setError(cause.code || 'AGENT_INTERNAL_FAILURE'))
    const offState = window.agentMvp.onState((runtime) => setState((current) => current ? { ...current, runtime } : current))
    const offEvent = window.agentMvp.onEvent((event) => setEvents((current) => [...current.slice(-19), event]))
    return () => { offState(); offEvent() }
  }, [])

  /* 开发入口没有正式配置通道，主题只能跟随系统；写成 data-theme 是为了消费
     tokens.css 的主题分支，不代表这里实现了正式窗口的 config.theme。 */
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light' }
    apply(); media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const jobStateSignature = state?.runtime.jobs.map((job) => `${job.runId}:${job.state}`).join('|') || ''
  useEffect(() => {
    if (!selected) { setMessages([]); return }
    window.agentMvp.messages(selected).then((value) => setMessages(value.messages)).catch((cause) => setError(cause.code || 'AGENT_INTERNAL_FAILURE'))
  }, [selected, jobStateSignature])

  /* 追加消息后只在用户本来就贴着底部时才跟随，向上翻阅时不抢滚动位置。 */
  useEffect(() => {
    const node = messageList.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [messages.length, preview])

  useEffect(() => { if (preview) previewPanel.current?.focus() }, [preview?.previewId])
  /* 焦点交还必须等 busy 落回 null：提交期间触发按钮仍是 disabled，那时 focus() 会被忽略。 */
  useEffect(() => {
    if (busy !== null || !returnFocus.current) return
    returnFocus.current = false; previewTrigger.current?.focus()
  }, [busy])

  const selectedSession = useMemo(() => state?.runtime.sessions.find((session) => session.sessionId === selected) || null, [state, selected])
  const jobs = state?.runtime.jobs || []
  const artifacts = state?.runtime.artifacts || []
  const sessions = state?.runtime.sessions || []

  const selectedJob = selection.kind === 'job' ? jobs.find((job) => job.runId === selection.runId) || null : null
  const selectedArtifact = selection.kind === 'artifact' ? artifacts.find((item) => item.artifactId === selection.artifactId) || null : null
  const detailKind: Selection['kind'] = selectedJob ? 'job' : selectedArtifact ? 'artifact' : 'session'

  const act = async (name: string, action: () => Promise<any>) => {
    setBusy(name); setError(null)
    try { return await action() } catch (cause: any) { setError(cause.code || 'AGENT_INTERNAL_FAILURE'); return null } finally { setBusy(null) }
  }

  const saveProvider = () => act('provider', async () => {
    const saved = await window.agentMvp.saveProvider({
      provider: form.provider, baseUrl: form.baseUrl, model: form.model,
      cloudDisclosureAccepted: form.cloudDisclosureAccepted, apiKey: form.apiKey
    })
    setForm((current: any) => ({ ...current, apiKey: '' }))
    setState((current) => current ? { ...current, provider: saved } : current)
  })
  const createFixture = (sourceId: 'loopback' | 'mic') => act('fixture', async () => { await window.agentMvp.createFixture(sourceId); await refresh() })
  const sendChat = () => act('chat', async () => {
    if (!selected || !prompt.trim()) return
    stickToBottom.current = true
    const result = await window.agentMvp.chat(selected, prompt.trim()); setMessages(result.messages)
  })
  /* 确认卡就长在对话流里，所以触发时把主视图切回对话 —— 动作和它的结果不分居两处。 */
  const makePreview = () => act('preview', async () => {
    if (!selected) return
    setView('chat'); stickToBottom.current = true
    setPreview(await window.agentMvp.preview(selected))
  })
  const decide = (decision: 'accepted' | 'rejected') => act('confirm', async () => {
    if (!preview) return
    await window.agentMvp.confirm(preview.previewId, decision); setPreview(null); await refresh()
    returnFocus.current = true
  })

  const selectSession = (sessionId: string) => { setSelected(sessionId); setSelection({ kind: 'session' }) }
  const isCloud = form.provider === 'openai-compatible'
  const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATES.includes(job.state)).length
  const statusLine = busy ? BUSY_STATUS[busy] || '正在处理…' : state?.runtime.runningRunId ? '有任务正在后台运行' : ''
  /* 同一时刻只允许一个主按钮：有待确认的任务时，「确认执行」才是此刻最该做的事。 */
  const sendClass = preview ? 'secondary-btn' : 'primary-btn'
  const latestEvent = events.length > 0 ? events[events.length - 1] : null

  return <div className="app-shell">
    <header className="titlebar">
      <div className="title-group"><strong>Live Subtitle Agent</strong><span>开发调试台 · 不是正式功能页面</span></div>
      <div className="app-status" role="status" aria-live="polite">{statusLine}</div>
    </header>

    <div className="toolbar">
      <label className="toolbar-field"><span className="field-label">AI 模型</span>
        <select className="control control-sm" data-testid="provider-type" value={form.provider}
          onChange={(event) => {
            const provider = event.target.value
            setForm({ ...form, provider, model: provider === 'deterministic-test' ? 'fixture-model' : form.model })
            if (provider === 'openai-compatible') setProviderOpen(true)
          }}>
          <option value="deterministic-test">内置假模型（不联网，仅供测试）</option>
          <option value="openai-compatible">云端模型服务（OpenAI 兼容）</option>
        </select></label>
      <span data-testid="credential-state" className="credential-state">
        <Icon name="key" />{state?.provider.hasCredential
          ? (state.provider.credentialPersisted ? '密钥已加密保存在这台电脑' : '密钥只在本次运行有效，关掉要重填')
          : isCloud ? '还没填密钥' : '不需要密钥'}</span>
      <button className="ghost-btn" aria-expanded={providerOpen} aria-controls="providerDetails"
        onClick={() => setProviderOpen((open) => !open)}>
        <Icon name="chevron" className={providerOpen ? 'rotate-down' : ''} />{providerOpen ? '收起设置' : '模型设置'}</button>
    </div>

    {providerOpen && <section className="provider-details" id="providerDetails" aria-label="AI 模型设置">
      <p className="panel-hint">这里只管 AI 模型，和字幕的语音识别没有关系；改动不会影响字幕功能。</p>
      <div className="field-grid">
        {isCloud && <>
          <label className="field"><span className="field-label">服务地址</span>
            <input className="control" data-testid="provider-url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://example.com/v1" /></label>
          <label className="field"><span className="field-label">模型名称</span>
            <input className="control" data-testid="provider-model" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></label>
          <label className="field"><span className="field-label">密钥</span>
            <input className="control" data-testid="provider-key" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              placeholder={state?.provider.hasCredential ? '已填过；留空就不改' : '只会交给主进程，不回显'} /></label>
        </>}
        {!isCloud && <p className="group-empty">内置假模型不联网、不需要地址和密钥，回答是固定的，只用来验证流程。</p>}
      </div>
      <div className="provider-foot">
        {isCloud && <label className="consent">
          <input data-testid="provider-disclosure" type="checkbox" checked={form.cloudDisclosureAccepted} onChange={(event) => setForm({ ...form, cloudDisclosureAccepted: event.target.checked })} />
          <span>我知道会把会话文字发给这个服务</span></label>}
        <button className="primary-btn" data-testid="provider-save" onClick={saveProvider} disabled={busy !== null}>保存</button>
      </div>
    </section>}

    {error && <div className="error-bar" role="alert" data-error-code={error}>
      <Icon name="alert" /><span>{errorText[error] || '出了点问题，请重试或检查模型设置。'}</span><code>{error}</code>
    </div>}

    <main className="workspace" style={{ '--w-left': `${layout.left}px`, '--w-right': `${layout.right}px`, '--h-detail': `${layout.detail}px` } as React.CSSProperties}>
      <aside className="session-panel" aria-label="会话列表">
        <div className="panel-heading"><h1>会话</h1>
          <p>{state === null ? '正在读取…' : sessions.length === 0 ? '这里只有测试用的会话' : `共 ${sessions.length} 条测试会话`}</p></div>
        <div className="fixture-actions">
          <button className="ghost-btn wide" data-testid="fixture-loopback" onClick={() => createFixture('loopback')} disabled={busy !== null}>
            <Icon name="plus" />新建测试会话（系统声音）</button>
          <button className="ghost-btn wide" data-testid="fixture-mic" onClick={() => createFixture('mic')} disabled={busy !== null}>
            <Icon name="plus" />新建测试会话（麦克风）</button>
        </div>
        <div className="session-list" role="list">
          {state !== null && sessions.length === 0 && <p className="list-message">还没有测试会话。上面两个按钮会造一条没有声音的假会话，只给这个调试台用；你真正的字幕历史在另一个窗口，不受影响。</p>}
          {sessions.map((session) => <div className="session-list-item" role="listitem" key={session.sessionId}>
            <button className="session-card" data-testid="session-item" aria-current={selected === session.sessionId} onClick={() => selectSession(session.sessionId)}>
              <strong>{date(session.startedAt)}</strong>
              <span className="summary"><Icon name={sourceIcon(session.sourceId)} />{sourceLabel(session.sourceId)}</span>
              <span className="state">{sessionStateLabel(session.state)} · {shortId(session.sessionId)}</span>
            </button></div>)}
        </div>
      </aside>

      <Splitter axis="x" className="splitter-left" label="调整会话列表宽度"
        value={layout.left} limits={LIMITS.left} onChange={(next) => setPane('left', next)} />

      <section className="view-slot" aria-label="主视图">
        <header className="slot-header">
          <div className="seg" role="tablist" aria-label="切换视图">
            <button role="tab" id="tabChat" aria-selected={view === 'chat'} aria-controls="viewChat"
              className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}><Icon name="chat" />对话</button>
            <button role="tab" id="tabRuns" aria-selected={view === 'runs'} aria-controls="viewRuns"
              className={view === 'runs' ? 'on' : ''} onClick={() => setView('runs')}><Icon name="task" />任务
              {activeJobs > 0 && <span className="tab-badge" aria-label={`${activeJobs} 个任务进行中`}>{activeJobs}</span>}</button>
          </div>
          <span className="slot-context">{selectedSession
            ? `${sourceLabel(selectedSession.sourceId)} · ${date(selectedSession.startedAt)}`
            : '未选择会话'}</span>
        </header>

        <div className="view-body">
          <section id="viewChat" role="tabpanel" aria-labelledby="tabChat" className={`view chat-view${view === 'chat' ? ' active' : ''}`}>
            <div className="message-list" ref={messageList}
              onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48 }}>
              {messages.length === 0 && !preview && <p className="list-message">
                {selectedSession ? '这里的聊天记录单独存在这个调试台里，不会进入你的字幕历史，也不会被记住。' : '先在左边选一条会话。'}</p>}
              {messages.map((message) => <article data-testid="message-item" key={message.messageId} className={`message message-${message.role}`}>
                <b className="message-role">{MESSAGE_ROLES[message.role] || '记录'}</b>
                <p className="message-body">{messageBody(message)}</p>
              </article>)}

              {/* 待确认的任务就地长在对话流末尾：触发点、说明和决定按钮在同一处。 */}
              {preview && <section className="message preview-card" data-testid="preview-panel" ref={previewPanel} tabIndex={-1} aria-labelledby="previewHeading">
                <b className="message-role" id="previewHeading">开始前请确认</b>
                <p className="preview-lead">要用这场会话的文字，生成一份参考结构化产物。确认后才会真正开始。</p>
                <dl className="preview-facts">
                  <dt>任务类型</dt><dd>{preview.recipeId}<span className="fact-note">固定流程，不可改</span></dd>
                  <dt>读取范围</dt><dd>到第 {preview.inputRef.inputWatermark} 条为止<span className="fact-note">之后新增的内容不算在内</span></dd>
                  <dt>内容指纹</dt><dd>{shortId(preview.inputRef.inputDigest)}<span className="fact-note">用来确认读到的内容没变过</span></dd>
                  <dt>是否上传</dt><dd>{preview.cloudDisclosure ? '会把文字发给云端模型服务' : '不发到云端，全程在本机'}</dd>
                </dl>
                <div className="preview-actions">
                  <button className="primary-btn" data-testid="preview-accept" onClick={() => decide('accepted')} disabled={busy !== null}>确认执行</button>
                  <button className="secondary-btn" data-testid="preview-reject" onClick={() => decide('rejected')} disabled={busy !== null}>不执行</button>
                </div>
                <p className="preview-note">这张确认卡只在本次运行有效，关掉应用后就没法再确认了。</p>
              </section>}
            </div>

            {/* 工具事件默认折成一行摘要，展开才看细节。元素始终挂载，只切显隐。 */}
            <div className="event-strip">
              <button className="event-toggle" aria-expanded={eventsOpen} aria-controls="toolEvents" disabled={events.length === 0}
                onClick={() => setEventsOpen((open) => !open)}>
                <Icon name="chevron" className={eventsOpen ? 'rotate-down' : ''} />
                <Icon name="tool" />
                <span className="event-title">AI 用了哪些工具</span>
                <span className="event-summary">{latestEvent
                  ? `最近：${eventLabel(latestEvent.event.type)}${latestEvent.event.toolName ? ` · ${latestEvent.event.toolName}` : ''}`
                  : '这一轮还没有记录'}</span>
              </button>
              <div className="event-list" id="toolEvents" hidden={!eventsOpen}>
                <p className="section-hint">只记这一轮，最多留 20 条、显示最近 6 条，关掉应用就没了。这不是完整的审计日志。</p>
                {events.slice(-6).map((entry, index) => <div className="event" data-testid="tool-event" key={`${entry.runId}-${index}`}>
                  <span>{eventLabel(entry.event.type)}</span>
                  <span className="event-meta">{entry.event.toolName || shortId(entry.runId)}{entry.event.isError ? ' · 出错' : ''}</span>
                </div>)}
              </div>
            </div>

            <Splitter axis="y" className="splitter-composer" label="调整输入框高度" invert
              value={layout.composer} limits={LIMITS.composer} onChange={(next) => setPane('composer', next)} />

            <div className="composer" style={{ height: `${layout.composer}px` }}>
              <textarea className="control" data-testid="chat-prompt" aria-label="要问 AI 的话" value={prompt}
                onChange={(event) => setPrompt(event.target.value)} disabled={!selected || busy !== null} />
              <div className="composer-actions">
                <p className="composer-hint">AI 的回答会在这一轮结束后一次性出现，中途没法停下。</p>
                <button className="secondary-btn" ref={previewTrigger} data-testid="preview-reference"
                  onClick={makePreview} disabled={!selected || busy !== null}>生成参考产物…</button>
                <button className={sendClass} data-testid="chat-send" onClick={sendChat}
                  disabled={!selected || !prompt.trim() || busy !== null}>{busy === 'chat' ? '等待中…' : '发送'}</button>
              </div>
            </div>
          </section>

          <section id="viewRuns" role="tabpanel" aria-labelledby="tabRuns" className={`view runs-view${view === 'runs' ? ' active' : ''}`}>
            <div className="runs-body">
              <section className="runs-section">
                <h2><Icon name="task" />后台任务</h2>
                <p className="section-hint">点一条看详情和取消。失败会自动重试，重试算同一个任务。</p>
                <div className="run-list" role="list">
                  {jobs.length === 0 && <p className="group-empty">还没有任务</p>}
                  {jobs.map((job) => { const stateView = jobStateView(job.state); return <div role="listitem" key={job.runId}>
                    <button className="run-card" data-testid="job-item" data-state={job.state}
                      aria-current={selection.kind === 'job' && selection.runId === job.runId}
                      onClick={() => setSelection({ kind: 'job', runId: job.runId })}>
                      <span className="run-state" data-tone={stateView.tone}><Icon name={stateView.icon} />{stateView.label}</span>
                      <span className="run-meta">第 {job.attemptCount} 次尝试 · {job.model} · {shortId(job.runId)}</span>
                      {job.errorCode && <span className="run-error">{errorText[job.errorCode] || `错误代码 ${job.errorCode}`}</span>}
                    </button></div> })}
                </div>
              </section>

              <section className="runs-section">
                <h2><Icon name="doc" />参考结构化产物</h2>
                <p className="section-hint">固定示例任务产出的内容，只用来验证流程；不是会后纪要、增强文本或个人记忆。</p>
                <div className="run-list" role="list">
                  {artifacts.length === 0 && <p className="group-empty">还没有产物</p>}
                  {artifacts.map((artifact) => <div role="listitem" key={artifact.artifactId}>
                    <button className="run-card" data-testid="artifact-item"
                      aria-current={selection.kind === 'artifact' && selection.artifactId === artifact.artifactId}
                      onClick={() => setSelection({ kind: 'artifact', artifactId: artifact.artifactId })}>
                      <span className="run-title">{artifact.content.title}</span>
                      <span className="run-meta">{artifact.content.bullets.length} 条要点 · {shortId(artifact.runId)}</span>
                    </button></div>)}
                </div>
              </section>
            </div>
          </section>
        </div>
      </section>

      <Splitter axis="x" className="splitter-right" label="调整详情栏宽度" invert
        value={layout.right} limits={LIMITS.right} onChange={(next) => setPane('right', next)} />
      <Splitter axis="y" className="splitter-detail" label="调整详情栏高度" invert
        value={layout.detail} limits={LIMITS.detail} onChange={(next) => setPane('detail', next)} />

      <aside className="detail-panel" aria-label="详情">
        <div className="panel-heading"><h1>详情</h1>
          <p>{detailKind === 'job' ? '当前选中：后台任务' : detailKind === 'artifact' ? '当前选中：参考结构化产物' : '当前选中：会话'}</p></div>
        <div className="detail-body">
          {detailKind === 'session' && (selectedSession
            ? <dl className="detail-facts">
                <dt>声音来源</dt><dd><Icon name={sourceIcon(selectedSession.sourceId)} />{sourceLabel(selectedSession.sourceId)}</dd>
                <dt>结束方式</dt><dd>{sessionStateLabel(selectedSession.state)}</dd>
                <dt>开始时间</dt><dd>{date(selectedSession.startedAt, true)}</dd>
                <dt>会话编号</dt><dd>{shortId(selectedSession.sessionId)}</dd>
                <dt>用哪份文字</dt><dd>字幕原文<span className="fact-note">这个调试台只读原文，不读精修稿</span></dd>
              </dl>
            : <p className="list-message">还没选会话。在左边选一条，或者先新建一条测试会话。</p>)}

          {detailKind === 'job' && selectedJob && <>
            <dl className="detail-facts">
              <dt>状态</dt><dd><span className="run-state" data-tone={jobStateView(selectedJob.state).tone}>
                <Icon name={jobStateView(selectedJob.state).icon} />{jobStateView(selectedJob.state).label}</span></dd>
              <dt>尝试次数</dt><dd>第 {selectedJob.attemptCount} 次</dd>
              <dt>使用模型</dt><dd>{selectedJob.model}</dd>
              <dt>任务编号</dt><dd>{shortId(selectedJob.runId)}</dd>
              {selectedJob.errorCode && <><dt>错误</dt><dd>{errorText[selectedJob.errorCode] || `错误代码 ${selectedJob.errorCode}`}</dd></>}
            </dl>
            {ACTIVE_JOB_STATES.includes(selectedJob.state) && <div className="detail-actions">
              <button className="secondary-btn" disabled={busy !== null}
                onClick={() => act('cancel', () => window.agentMvp.cancel(selectedJob.runId))}>取消这个任务</button>
            </div>}
          </>}

          {detailKind === 'artifact' && selectedArtifact && <>
            <dl className="detail-facts">
              <dt>标题</dt><dd>{selectedArtifact.content.title}</dd>
              <dt>产物类型</dt><dd>{selectedArtifact.type}</dd>
              <dt>来自任务</dt><dd>{shortId(selectedArtifact.runId)}</dd>
            </dl>
            <ul className="detail-bullets">{selectedArtifact.content.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
          </>}
        </div>
      </aside>
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
