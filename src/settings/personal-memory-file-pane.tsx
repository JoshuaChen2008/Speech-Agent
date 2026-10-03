import { useCallback, useEffect, useRef, useState } from 'react'
import { PersonalMemorySharingPane } from './personal-memory-sharing-pane'

type Dict = Record<string, any>
const kinds = [['decision', '决定'], ['conclusion', '结论'], ['todo', '待办'], ['term', '术语'], ['preference', '偏好'], ['project_fact', '项目事实'], ['experience', '经历']]
const labels: Dict = { ready: '已确认', new: '尚未确认', pending: '外部修改待确认', metadata_required: '需要选择类型与范围', invalid: '格式无效', conflict: 'ID 重复，需在文件中修正', forgotten: '已停止使用', suppressed: '已撤销，恢复需明确确认', recovery: '等待恢复', writing: '正在保存' }
const errors: Dict = { MEMORY_FILE_CONFLICT: '文件或目录已变化，请刷新后核对当前正文。', MEMORY_FILE_ROOT_UNAVAILABLE: '记忆目录暂不可读，引用已暂停。请恢复目录或重新选择。', MEMORY_FILE_WRITE_DISABLED: '当前目录禁止应用写入，可以在外部编辑后确认。', MEMORY_FILE_NATIVE_UNAVAILABLE: '暂时无法安全修改记忆文件，已暂停保存和确认。', MODEL_CONFIG_REVISION_CONFLICT: '语义搜索模型设置已变化，请刷新后重试。', AGENT_CONTEXT_REVISION_CONFLICT: '记忆已变化，请刷新后重新确认。' }

export function PersonalMemoryFilePane ({ scopes = [] }: { scopes?: Dict[] }) {
  const api = window.shell
  const available = typeof api?.personalMemoryFiles === 'function'
  const [status, setStatus] = useState<Dict | null>(null)
  const [files, setFiles] = useState<Dict[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [review, setReview] = useState<Dict | null>(null)
  const [entry, setEntry] = useState<Dict | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState('')
  const [base, setBase] = useState('/v1')
  const [model, setModel] = useState('')
  const [credential, setCredential] = useState('')
  const [disclosed, setDisclosed] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [recovery, setRecovery] = useState<Dict | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const call = useCallback(async (command: Dict) => {
    const result = await api.personalMemoryFiles({ contractId: 'speech-agent.personal-memory.files', contractVersion: '1.0.0', command })
    if (!result.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code })
    return result.result
  }, [api])
  const refresh = useCallback(async () => {
    const s = await call({ type: 'status' }); const page = await call({ type: 'list', after: null })
    if (!mounted.current) return
    setStatus(s); setFiles(page.items); setCursor(page.nextCursor)
  }, [call])
  useEffect(() => {
    mounted.current = true
    if (!available) return
    void refresh().catch(() => { if (mounted.current) setNotice('暂时无法读取记忆文件。') })
    let timer: ReturnType<typeof setTimeout>
    const unsubscribe = api.onPersonalMemoryFilesChanged?.(() => { clearTimeout(timer); timer = setTimeout(() => { if (!pending.current) void refresh().catch(() => {}) }, 300) })
    return () => { mounted.current = false; clearTimeout(timer); unsubscribe?.() }
  }, [available, api, refresh])
  useEffect(() => {
    const e = status?.embedding
    if (e) { setOrigin(e.httpsOrigin); setBase(e.basePath); setModel(e.modelId); setDisclosed(e.disclosureAccepted); setEnabled(e.enabled) }
  }, [status?.embedding?.revision])
  const run = async (command: Dict, done?: (value: Dict) => void) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice('')
    try { const value = await call(command); if (mounted.current) { done?.(value); if (!['search', 'list', 'recoveryReview'].includes(command.type)) await refresh() } }
    catch (e: any) { if (mounted.current) setNotice(errors[e.code] || '这次操作未被确认，请刷新后重试。') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  if (!available) return null
  const root = status?.root
  return <details className="memory-file-pane" open aria-busy={busy}>
    <summary>记忆文件与检索</summary>
    <p className="hint">已确认的记忆保存在 Markdown 文件中。你可以用自己的编辑器修改；内容、类型或使用范围变化后，需要在这里确认，助手才会再次引用。</p>
    {notice && <p role="alert" className="settings-status">{notice}</p>}
    <PersonalMemorySharingPane scopes={scopes} />
    <div className="agent-model-actions">
      <span>{root?.selected ? `目录：${root.displayName}` : '正在读取目录'}</span>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run({ type: 'chooseRoot' })}>选择记忆目录</button>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => void refresh().catch(() => setNotice('暂时无法刷新。'))}>刷新文件</button>
    </div>
    {root?.reason && <p role="status">记忆目录暂不可读，引用已暂停；这不会撤销已有记忆。</p>}
    {root?.selected && <label className="memory-file-control"><input type="checkbox" checked={root.writeEnabled} disabled={busy} onChange={e => void run({ type: 'setWrite', rootId: root.rootId, enabled: e.currentTarget.checked })} />允许应用写入此目录</label>}
    {root?.selected && !root.nativeAvailable && <p role="status">暂时无法安全修改记忆文件。仍可查看文件，保存和确认已暂停。</p>}
    <form className="agent-model-actions" onSubmit={e => { e.preventDefault(); void run({ type: 'search', query }, page => { setFiles(page.items); setCursor(null) }) }}>
      <input aria-label="搜索记忆文件" value={query} onChange={e => setQuery(e.currentTarget.value)} placeholder="中文词、名称或术语" />
      <button className="secondary-btn" disabled={busy || !query.trim()}>关键词搜索</button>
    </form>
    <div className="memory-file-list">
      {files.map(file => <article className="agent-context-item" key={file.fileId}>
        <div className="memory-file-heading"><span>{file.name}</span><span>{labels[file.state] || file.state}</span></div>
        {file.entry && <p className="agent-context-item-text">{file.entry.display_text}</p>}
        <div className="agent-model-actions">
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run({ type: 'openFile', fileId: file.fileId })}>用外部编辑器打开</button>
          {file.entry && !['ready', 'conflict', 'invalid', 'recovery', 'writing'].includes(file.state) && <button type="button" className="secondary-btn" disabled={busy || !root?.nativeAvailable} onClick={() => { setReview(file); setEntry(file.entry) }}>核对并确认</button>}
        </div>
      </article>)}
      {files.length === 0 && <p className="hint">当前没有匹配的记忆文件。</p>}
      {cursor && <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run({ type: 'list', after: cursor }, page => { setFiles(old => [...old, ...page.items]); setCursor(page.nextCursor) })}>更多文件</button>}
    </div>
    {review && entry && <div className="agent-context-confirm" role="alertdialog" aria-label="确认记忆文件修改">
      <p>{['suppressed', 'forgotten'].includes(review.state) ? '这条记忆已撤销或停止使用。确认后将恢复使用。' : '确认以下正文、类型和范围为你的个人记忆。'}</p>
      <p className="agent-context-item-text">{entry.display_text}</p>
      {review.state === 'metadata_required' && <div className="agent-context-form-row">
        <select aria-label="文件记忆类型" value={entry.kind} onChange={e => setEntry({ ...entry, kind: e.currentTarget.value })}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="文件记忆范围" value={`${entry.scope.kind}:${entry.scope.reference || ''}`} onChange={e => { const [kind, ...ref] = e.currentTarget.value.split(':'); setEntry({ ...entry, scope: { kind, reference: kind === 'global' ? null : ref.join(':') } }) }}><option value="global:">所有会话</option>{scopes.map(scope => <option key={scope.scope_id} value={`${scope.kind}:${scope.scope_id}`}>{scope.display_name}</option>)}</select>
      </div>}
      {review.state !== 'metadata_required' && <p className="hint">类型：{kinds.find(([kind]) => kind === entry.kind)?.[1]}；范围：{entry.scope.kind === 'global' ? '所有会话' : scopes.find(scope => scope.scope_id === entry.scope.reference)?.display_name || ({ session: '所选会话', project: '所选项目', topic: '所选主题' } as Dict)[entry.scope.kind] || '未指定范围'}</p>}
      <div className="agent-model-actions"><button type="button" className="primary-btn" disabled={busy} onClick={() => void run({ type: 'confirm', rootId: root.rootId, fileId: review.fileId, expectedHash: review.byteHash, restore: ['suppressed', 'forgotten'].includes(review.state), entry: review.state === 'metadata_required' ? entry : null }, () => { setReview(null); setEntry(null) })}>确认本次修改</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => setReview(null)}>取消</button></div>
    </div>}
    {status?.legacy?.length > 0 && <details><summary>将已有记忆保存为文件</summary><p className="hint">仅迁移勾选的条目，保留来源、修改记录和停用状态。</p>
      {status?.legacy.map((item: Dict) => <label className="memory-file-control" key={item.memoryId}><input type="checkbox" disabled={busy} checked={selected.includes(item.memoryId)} onChange={e => { const checked = e.currentTarget.checked; setSelected(old => checked ? [...old, item.memoryId] : old.filter(id => id !== item.memoryId)) }} />{item.entry.display_text}</label>)}
      <button type="button" className="secondary-btn" disabled={busy || !root?.writeEnabled || !root?.nativeAvailable || !selected.length} onClick={() => void run({ type: 'migrate', rootId: root.rootId, memoryIds: selected }, () => setSelected([]))}>将选中记忆移到文件</button>
    </details>}
    <details><summary>语义搜索模型（Embedding）</summary><p className="hint">用于按意思查找记忆。开启后，会将当前有效的已确认记忆和搜索内容发送到你填写的 HTTPS 服务地址。不会发送字幕原文和待确认记忆。API 密钥单独保存；数据处理和保留方式以服务商政策为准。</p>
      <div className="memory-file-fields"><label>HTTPS 服务地址<input aria-label="语义搜索模型 HTTPS 服务地址" value={origin} onChange={e => setOrigin(e.currentTarget.value)} /></label><label>API 基础路径<input aria-label="语义搜索模型 API 基础路径" value={base} onChange={e => setBase(e.currentTarget.value)} /></label><label>模型 ID<input aria-label="语义搜索模型 ID" value={model} onChange={e => setModel(e.currentTarget.value)} /></label></div>
      <label className="memory-file-control"><input type="checkbox" checked={disclosed} onChange={e => { setDisclosed(e.currentTarget.checked); if (!e.currentTarget.checked) setEnabled(false) }} />我允许将上述记忆和搜索内容发送到此服务</label>
      <label className="memory-file-control"><input type="checkbox" checked={enabled} disabled={!disclosed} onChange={e => setEnabled(e.currentTarget.checked)} />启用语义搜索</label>
      <button className="secondary-btn" type="button" disabled={busy || !origin || !model} onClick={() => void run({ type: 'configureEmbedding', command: { type: 'configureEmbedding', expectedRevision: status?.embedding?.revision || 0, httpsOrigin: origin, basePath: base, modelId: model, enabled, disclosureAccepted: disclosed } })}>保存语义搜索设置</button>
      <div className="agent-model-actions"><input type="password" autoComplete="off" aria-label="语义搜索模型 API 密钥" value={credential} onChange={e => setCredential(e.currentTarget.value)} placeholder="API 密钥" /><button type="button" className="secondary-btn" disabled={busy || !credential} onClick={() => { const value = credential; setCredential(''); void run({ type: 'configureEmbedding', command: { type: 'setEmbeddingCredential', expectedRevision: status?.embedding?.revision || 0, credential: value } }) }}>保存 API 密钥</button><button className="secondary-btn" type="button" disabled={busy || !status?.embedding?.credentialPresent} onClick={() => void run({ type: 'configureEmbedding', command: { type: 'clearEmbeddingCredential', expectedRevision: status?.embedding?.revision || 0 } })}>清除 API 密钥</button></div>
      <p className="hint">{status?.embedding?.credentialPresent ? status.embedding.credentialScope === 'session_only' ? 'API 密钥仅在本次运行中保留，退出后需重新填写。' : 'API 密钥已加密保存。' : '尚未保存 API 密钥。'}</p>
    </details>
    <p role="status">关键词搜索索引 {status?.index?.documents || 0} 条；语义搜索索引 {status?.index?.vectors || 0} 条。{status?.index?.state === 'indexing' ? `正在建立索引，已处理 ${status.index.processed} 条。` : status?.index?.state === 'failed' ? '语义搜索索引暂不可用，继续使用关键词检索。' : !status?.embedding?.enabled ? '语义搜索未开启，继续使用关键词检索。' : ''}</p>
    <div className="agent-model-actions"><button className="secondary-btn" type="button" disabled={busy || !root?.selected} onClick={() => void run({ type: 'rebuild', rootId: root.rootId })}>重建搜索索引</button><button className="secondary-btn" type="button" disabled={busy || status?.index?.state !== 'indexing'} onClick={() => void run({ type: 'cancelIndex' })}>停止建立索引</button><button className="secondary-btn" type="button" disabled={busy} onClick={() => void run({ type: 'exportGovernance' })}>导出来源与撤销记录</button><button className="secondary-btn" type="button" disabled={busy || !root?.selected} onClick={() => void run({ type: 'importGovernance', rootId: root.rootId })}>导入来源与撤销记录</button></div>
    <p className="hint">迁移到另一台设备时，另行复制记忆目录并导入来源与撤销记录；导入不会自动确认新正文。</p>
    {status?.cleanup?.length > 0 && <p role="status">已撤销记忆的文件清理尚未结束。被占用或禁止写入的文件可以重试；正文已变化的文件需自行处理，仍不会供助手引用。<button type="button" className="secondary-btn" disabled={busy || !root?.writeEnabled} onClick={() => void run({ type: 'retryCleanup', rootId: root.rootId })}>重试文件清理</button></p>}
    {status?.recovery?.map((op: Dict) => <p key={op.operationId}>有一次保存未结束，需要核对后恢复。<button type="button" className="secondary-btn" disabled={busy} onClick={() => void run({ type: 'recoveryReview', operationId: op.operationId }, setRecovery)}>核对恢复内容</button></p>)}
    {recovery && <div className="agent-context-confirm" role="alertdialog" aria-label="恢复个人记忆文件"><p>选择并确认恢复版本。如果文件再次变化，将暂停恢复，避免覆盖你的修改。</p>{Object.entries(recovery.versions).map(([version, value]: [string, any]) => value && <div key={version}><p>{({ old: '保存前', new: '待保存', current: '当前文件' } as Dict)[version]}</p><p className="agent-context-item-text">{value.display_text}</p><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run({ type: 'recoveryRestore', rootId: root.rootId, operationId: recovery.operationId, expectedHash: recovery.expectedHash, version }, () => setRecovery(null))}>确认恢复此版本</button></div>)}<button className="secondary-btn" type="button" disabled={busy} onClick={() => setRecovery(null)}>取消</button></div>}
  </details>
}
