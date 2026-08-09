import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../ui/shared/tokens.css'
import './styles.css'

type Session = { sessionId: string; sourceId: 'loopback' | 'mic'; state: string; startedAt: number }
type Job = { runId: string; state: string; errorCode: string | null; attemptCount: number; model: string }
type Artifact = { artifactId: string; runId: string; sessionId: string; type: string; content: { title: string; bullets: string[] } }
type Message = { messageId: string; role: string; content: Record<string, any> }
type State = { runtime: { sessions: Session[]; jobs: Job[]; artifacts: Artifact[]; runningRunId: string | null }; provider: any }

const errorText: Record<string, string> = {
  AGENT_PROVIDER_AUTH_FAILED: 'Agent 模型 provider 凭据不可用。',
  AGENT_PROVIDER_TIMEOUT: 'Agent 模型 provider 响应超时。',
  AGENT_PROVIDER_UNAVAILABLE: 'Agent 模型 provider 当前不可用。',
  AGENT_OUTPUT_INVALID: '模型返回内容未通过固定结构校验。',
  AGENT_PERMISSION_DENIED: '请求超出固定 Agent 能力边界。',
  AGENT_REQUEST_INVALID: '请求与当前冻结输入不一致。'
}

function shortId (value: string) { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value }

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
    refresh().catch((cause) => setError(errorText[cause.code] || cause.code))
    const offState = window.agentMvp.onState((runtime) => setState((current) => current ? { ...current, runtime } : current))
    const offEvent = window.agentMvp.onEvent((event) => setEvents((current) => [...current.slice(-19), event]))
    return () => { offState(); offEvent() }
  }, [])

  useEffect(() => {
    if (!selected) { setMessages([]); return }
    window.agentMvp.messages(selected).then((value) => setMessages(value.messages)).catch((cause) => setError(errorText[cause.code] || cause.code))
  }, [selected])

  const selectedSession = useMemo(() => state?.runtime.sessions.find((session) => session.sessionId === selected) || null, [state, selected])

  const act = async (name: string, action: () => Promise<any>) => {
    setBusy(name); setError(null)
    try { return await action() } catch (cause: any) { setError(errorText[cause.code] || cause.code || 'AGENT_INTERNAL_FAILURE'); return null } finally { setBusy(null) }
  }

  const saveProvider = () => act('provider', async () => {
    const saved = await window.agentMvp.saveProvider({
      provider: form.provider,
      baseUrl: form.baseUrl,
      model: form.model,
      cloudDisclosureAccepted: form.cloudDisclosureAccepted,
      apiKey: form.apiKey
    })
    setState((current) => current ? { ...current, provider: saved } : current)
  })
  const createFixture = (sourceId: 'loopback' | 'mic') => act('fixture', async () => { await window.agentMvp.createFixture(sourceId); await refresh() })
  const sendChat = () => act('chat', async () => {
    if (!selected || !prompt.trim()) return
    const result = await window.agentMvp.chat(selected, prompt.trim()); setMessages(result.messages)
  })
  const makePreview = () => act('preview', async () => { if (selected) setPreview(await window.agentMvp.preview(selected)) })
  const decide = (decision: 'accepted' | 'rejected') => act('confirm', async () => {
    if (!preview) return; await window.agentMvp.confirm(preview.previewId, decision); setPreview(null); await refresh()
  })

  return <div className="app-shell">
    <header className="titlebar"><span>Live Subtitle Agent</span><small>隔离内核调试入口</small></header>
    <section className="provider-strip" aria-label="Agent 模型 provider">
      <div><strong>Agent 模型 provider</strong><span>与识别 provider 分离；只处理合成终态会话。</span></div>
      <label>类型<select value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value, model: event.target.value === 'deterministic-test' ? 'fixture-model' : form.model })}>
        <option value="deterministic-test">确定性测试 provider</option><option value="openai-compatible">OpenAI-compatible HTTPS</option>
      </select></label>
      {form.provider === 'openai-compatible' && <>
        <label>HTTPS 地址<input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://example.com/v1" /></label>
        <label>模型<input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></label>
        <label>新凭据<input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={state?.provider.hasCredential ? '已配置；留空保持不变' : '仅提交到主进程'} /></label>
        <label className="consent"><input type="checkbox" checked={form.cloudDisclosureAccepted} onChange={(event) => setForm({ ...form, cloudDisclosureAccepted: event.target.checked })} />我确认终态会话正文将发送给此服务</label>
      </>}
      <button onClick={saveProvider} disabled={busy !== null}>保存</button>
      <span className="credential-state">{state?.provider.hasCredential ? (state.provider.credentialPersisted ? '凭据已加密保存在本机' : '凭据仅本次进程可用') : form.provider === 'deterministic-test' ? '无需凭据' : '尚未配置凭据'}</span>
    </section>

    {error && <div className="error" role="alert">{error}</div>}

    <main className="workspace">
      <aside className="sessions">
        <div className="panel-heading"><div><strong>终态会话</strong><span>仅合成、无音频</span></div></div>
        <div className="fixture-actions"><button onClick={() => createFixture('loopback')} disabled={busy !== null}>添加系统音频 fixture</button><button onClick={() => createFixture('mic')} disabled={busy !== null}>添加麦克风 fixture</button></div>
        <div className="session-list">{state?.runtime.sessions.map((session) => <button key={session.sessionId} className={selected === session.sessionId ? 'selected' : ''} onClick={() => setSelected(session.sessionId)}>
          <strong>{session.sourceId === 'loopback' ? '系统音频' : '麦克风'}</strong><span>{shortId(session.sessionId)}</span><small>{session.state}</small>
        </button>)}</div>
      </aside>

      <section className="conversation">
        <div className="panel-heading"><div><strong>调试聊天</strong><span>{selectedSession ? `${selectedSession.sourceId === 'loopback' ? '系统音频' : '麦克风'} · ${shortId(selectedSession.sessionId)}` : '请先选择终态会话'}</span></div><button onClick={makePreview} disabled={!selected || busy !== null}>预览参考产物</button></div>
        <div className="message-list">{messages.length === 0 && <p className="empty">聊天记录单独保存在隔离 SQLite，不进入个人记忆。</p>}{messages.map((message) => <article key={message.messageId} className={`message ${message.role}`}>
          <b>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Agent' : '工具事件'}</b>
          <p>{message.content.text || message.content.code || (message.content.recipeId ? `执行预览 · ${message.content.recipeId}` : message.content.state ? `任务 ${message.content.state}` : message.content.decision)}</p>
        </article>)}</div>
        <div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={!selected || busy !== null} /><button onClick={sendChat} disabled={!selected || !prompt.trim() || busy !== null}>{busy === 'chat' ? '响应中…' : '发送'}</button></div>
      </section>

      <aside className="inspector">
        <div className="panel-heading"><div><strong>上下文与任务</strong><span>只显示脱敏身份与状态</span></div></div>
        {preview && <section className="preview"><strong>执行预览</strong><dl><dt>固定 recipe</dt><dd>{preview.recipeId}</dd><dt>输入水位</dt><dd>{preview.inputRef.inputWatermark}</dd><dt>输入 digest</dt><dd>{shortId(preview.inputRef.inputDigest)}</dd><dt>云端正文披露</dt><dd>{preview.cloudDisclosure ? '是' : '否'}</dd></dl><div><button onClick={() => decide('accepted')}>确认执行</button><button className="secondary" onClick={() => decide('rejected')}>拒绝</button></div></section>}
        <section><h2>后台任务</h2>{state?.runtime.jobs.length === 0 && <p className="empty">暂无任务</p>}{state?.runtime.jobs.map((job) => <div className="job" key={job.runId}><div><strong>{job.state}</strong><span>{shortId(job.runId)}</span></div><small>尝试 {job.attemptCount} · {job.model}</small>{job.errorCode && <em>{job.errorCode}</em>}{['queued', 'retry_wait', 'running'].includes(job.state) && <button onClick={() => act('cancel', () => window.agentMvp.cancel(job.runId))}>取消</button>}</div>)}</section>
        <section><h2>参考结构化产物</h2>{state?.runtime.artifacts.length === 0 && <p className="empty">暂无产物</p>}{state?.runtime.artifacts.map((artifact) => <article className="artifact" key={artifact.artifactId}><strong>{artifact.content.title}</strong><small>{artifact.type} · {shortId(artifact.runId)}</small><ul>{artifact.content.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul></article>)}</section>
        <section><h2>受控工具事件</h2>{events.slice(-6).map((entry, index) => <div className="event" key={`${entry.runId}-${index}`}><span>{entry.event.type}</span>{entry.event.toolName && <small>{entry.event.toolName}</small>}</div>)}</section>
      </aside>
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
