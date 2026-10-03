import { useCallback, useEffect, useRef, useState } from 'react'

type Dict = Record<string, any>
const kinds: Dict = { decision: '决定', conclusion: '结论', todo: '待办', term: '术语', preference: '偏好', project_fact: '项目事实', experience: '经历' }
export function PersonalMemorySharingPane ({ scopes = [] }: { scopes?: Dict[] }) {
  const api = window.shell
  const [items, setItems] = useState<Dict[]>([])
  const [after, setAfter] = useState<string | null>(null)
  const [scopeKey, setScopeKey] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<Dict | null>(null)
  const [format, setFormat] = useState('markdown')
  const [mcp, setMcp] = useState<Dict>({ running: false })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const mounted = useRef(true); const pending = useRef(false); const generation = useRef(0)
  const call = useCallback(async (command: Dict) => {
    const response = await api.personalMemoryFiles({ contractId: 'speech-agent.personal-memory.files', contractVersion: '1.0.0', command })
    if (!response.ok) throw Object.assign(new Error(), { code: response.error?.code })
    return response.result
  }, [api])
  const run = async (command: Dict, done: (value: Dict) => void) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice(''); const token = generation.current
    try { const value = await call(command); if (mounted.current && token === generation.current) done(value) }
    catch (error: any) { if (mounted.current) { setPreview(null); setNotice(error.code === 'MEMORY_FILE_SHARING_DISABLED' ? '请先开启 AI 助手和个人记忆，再选择需要对外使用的内容。' : '内容或授权已变化，或操作未被确认。请刷新并重新预览；导出取消不会保存文件。') } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const scope = scopeKey === 'all' ? null : scopeKey === 'global' ? { kind: 'global', reference: null } : { kind: scopes.find(s => s.scope_id === scopeKey)?.kind, reference: scopeKey }
  const load = (cursor: string | null = null) => void run({ type: 'contentList', scope, after: cursor }, page => {
    setItems(old => cursor ? [...old, ...page.items.filter((item: Dict) => !old.some(row => row.memoryId === item.memoryId))] : page.items)
    setAfter(page.nextCursor); if (!cursor) { setSelected([]); setPreview(null) }
  })
  useEffect(() => {
    mounted.current = true
    void call({ type: 'mcpStatus' }).then(value => { if (mounted.current) setMcp(value) }).catch(() => {})
    const unsubscribe = api.onPersonalMemoryFilesChanged?.(() => { generation.current++; setPreview(null); setNotice('记忆已变化，请刷新并重新预览。'); void call({ type: 'mcpStatus' }).then(value => { if (mounted.current) setMcp(value) }).catch(() => {}) })
    return () => { mounted.current = false; generation.current++; unsubscribe?.() }
  }, [api, call])
  return <details className="memory-file-pane">
    <summary>导出记忆与只读 MCP</summary>
    <p className="hint">选择最多20条已确认记忆，预览后复制或导出。包含正文、类型、范围和来源身份。外部助手如何保存或发送这些内容，由你选择的客户端决定；已复制的副本不会随这里的撤销自动删除。</p>
    {notice && <p role="status">{notice}</p>}
    <div className="agent-model-actions">
      <label>选择范围<select aria-label="对外使用的记忆范围" disabled={busy} value={scopeKey} onChange={e => { generation.current++; setScopeKey(e.currentTarget.value); setItems([]); setAfter(null); setSelected([]); setPreview(null) }}><option value="all">全部范围（逐条选择）</option><option value="global">全局记忆</option>{scopes.filter(s => ['session', 'project', 'topic'].includes(s.kind)).map(s => <option key={s.scope_id} value={s.scope_id}>{s.display_name}</option>)}</select></label>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => load()}>读取可选记忆</button>
    </div>
    {items.map(item => <label className="memory-file-control" key={item.memoryId}><input type="checkbox" disabled={busy || selected.length >= 20 && !selected.includes(item.memoryId)} checked={selected.includes(item.memoryId)} onChange={e => { const checked = e.currentTarget.checked; setSelected(old => checked ? [...old, item.memoryId] : old.filter(id => id !== item.memoryId)); setPreview(null) }} /><span>{item.text}（{kinds[item.kind] || item.kind} · {item.scope.label}）</span></label>)}
    {after && <button type="button" className="secondary-btn" disabled={busy} onClick={() => load(after)}>更多可选记忆</button>}
    <button type="button" className="secondary-btn" disabled={busy || !selected.length} onClick={() => void run({ type: 'contentPreview', memoryIds: selected }, setPreview)}>预览选中内容（{selected.length}）</button>
    {preview && <div aria-label="个人记忆内容预览"><p>本次包含 {preview.items.length} 条已确认记忆。</p>{preview.items.map((item: Dict) => <article className="agent-context-item" key={item.memoryId}><strong>{kinds[item.kind] || item.kind} · {item.scope.label}</strong><p className="agent-context-item-text">{item.text}</p><details><summary>导出的来源身份</summary><pre>{JSON.stringify(item.sources, null, 2)}</pre></details></article>)}</div>}
    <div className="agent-model-actions"><select aria-label="个人记忆内容格式" value={format} disabled={busy} onChange={e => setFormat(e.currentTarget.value)}><option value="markdown">Markdown</option><option value="json">JSON</option></select>
      <button type="button" className="secondary-btn" disabled={busy || !preview} onClick={() => void run({ type: 'contentCopy', memoryIds: selected, digest: preview!.digest, format }, () => setNotice('选中内容已复制。'))}>复制内容</button>
      <button type="button" className="secondary-btn" disabled={busy || !preview} onClick={() => void run({ type: 'contentExport', memoryIds: selected, digest: preview!.digest, format }, value => setNotice(value.cancelled ? '已取消导出。' : '选中内容已导出。'))}>导出内容</button>
    </div>
    <p className="hint">只读 MCP 允许本机客户端列举、读取和关键词查询这次选中的记忆。授权绑定本次修订；记忆变化后需重新授权。关闭共享、暂停个人记忆或退出应用后停止读取；应用重启后默认关闭。</p>
    <p role="status">{mcp.running ? `正在共享 ${mcp.count} 条记忆 · ${mcp.url}` : '只读 MCP 已关闭'}</p>
    <div className="agent-model-actions">
      <button type="button" className="secondary-btn" disabled={busy || !preview} onClick={() => void run({ type: 'mcpStart', memoryIds: selected, digest: preview!.digest }, value => { setMcp(value); setNotice('已授权选中内容。请复制连接配置到支持 HTTP MCP 的本机客户端。') })}>授权选中内容并开启 MCP</button>
      <button type="button" className="secondary-btn" disabled={busy || !mcp.running} onClick={() => void run({ type: 'mcpCopyConfig' }, () => setNotice('连接配置已复制，其中含本次访问令牌，请仅提供给信任的客户端。'))}>复制 MCP 连接配置</button>
      <button type="button" className="secondary-btn" disabled={busy || !mcp.running} onClick={() => void run({ type: 'mcpStop' }, setMcp)}>停止共享</button>
    </div>
  </details>
}
