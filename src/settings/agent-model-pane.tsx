import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { acceptsRevision, capabilityFormToCapabilities, capabilitySummary, deriveProfileId,
  emptyCapabilityForm, modelTargets, CREDENTIAL_LABELS, PURPOSE_LABELS, ASSIGNMENT_LABELS,
  MODEL_TEST_STATUS_LABELS, MODEL_TEST_NEXT_ACTION_LABELS, type CapabilityForm,
  type CatalogSnapshot, type ModelPreset, type ProfileEntry, type ModelPurpose } from './agent-model-view-model'

type Dict = Record<string, any>
type Draft = { profileId: string, label: string, url: string, credential: string, modelId: string,
  capabilities: CapabilityForm, presetId: string, makeDefault: boolean, advanced: boolean, error: string }
type Test = { pending: boolean, result: Dict | null, revision: number }
const HEADER = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }
const TEST_HEADER = { contractId: 'agent-model-test-ui', contractVersion: '1.0.0' }
const savedUrl = (profile: ProfileEntry) => profile.httpsOrigin + profile.basePath
function connection (input: string): { httpsOrigin: string, basePath: string } | null {
  try {
    const value = new URL(input.trim())
    if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash ||
        value.pathname.split('/').some((segment) => decodeURIComponent(segment) === '..')) return null
    return { httpsOrigin: value.origin, basePath: value.pathname || '/' }
  } catch { return null }
}
function capabilityDraft (item: { capabilities: Record<string, any> }): CapabilityForm {
  const c = item.capabilities
  return { maxInputTokens: String(c.maxInputTokens), maxOutputTokens: String(c.maxOutputTokens),
    supportsToolCalling: c.supportsToolCalling, supportsStructuredOutput: c.supportsStructuredOutput,
    supportsStreaming: c.supportsStreaming, usageReporting: c.usageReporting }
}
function CapabilityEditor ({ draft, change, busy }: {
  draft: Draft, change: (patch: Partial<Draft>) => void, busy: boolean
}): ReactElement {
  const c = draft.capabilities
  const update = (patch: Partial<CapabilityForm>) => change({ capabilities: { ...c, ...patch } })
  return <details className="wizard-details" open={draft.advanced}
    onToggle={(event) => change({ advanced: event.currentTarget.open, error: draft.error })}>
    <summary>模型能力与高级设置</summary>
    <div className="row"><label className="label" htmlFor="agent-label">服务名称</label>
      <input id="agent-label" value={draft.label} disabled={busy} onChange={(event) => change({ label: event.currentTarget.value })} /></div>
    <p className="hint">请根据服务商文档确认以下六项能力。不支持返回用量的模型会显示“用量未知”。</p>
    {([['maxInputTokens', '最大输入 token'], ['maxOutputTokens', '最大输出 token']] as const).map(([field, label]) =>
      <div className="row" key={field}><label className="label" htmlFor={field}>{label}</label>
        <input id={field} type="number" min={1} step={1} disabled={busy} value={c[field]}
          onChange={(event) => update({ [field]: event.currentTarget.value })} /></div>)}
    {([['supportsToolCalling', '工具调用'], ['supportsStructuredOutput', '结构化输出'],
      ['supportsStreaming', '流式输出'], ['usageReporting', '返回用量']] as const).map(([field, label]) =>
      <div className="row capability-row" key={field}><span className="label">{label}</span>
        <div className="seg" role="group" aria-label={label}>
          <button type="button" className={c[field] === true ? 'on' : ''} aria-pressed={c[field] === true}
            disabled={busy} onClick={() => update({ [field]: true })}>支持</button>
          <button type="button" className={c[field] === false ? 'on' : ''} aria-pressed={c[field] === false}
            disabled={busy} onClick={() => update({ [field]: false })}>不支持</button>
        </div></div>)}
  </details>
}

export function AgentModelPane ({ shell }: { shell: Dict }): ReactElement {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null)
  const current = useRef<CatalogSnapshot | null>(null)
  const mounted = useRef(true)
  const [unavailable, setUnavailable] = useState(false)
  const [presets, setPresets] = useState<ModelPreset[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'status' | 'alert'>('status')
  const [picker, setPicker] = useState(false)
  const pickerTrigger = useRef<HTMLButtonElement | null>(null)
  const [search, setSearch] = useState('')
  const [candidate, setCandidate] = useState('')
  const [tests, setTests] = useState<Record<string, Test>>({})
  const pendingTests = useRef(new Map<string, string>())
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({})
  const [suggestionStatus, setSuggestionStatus] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ profileId: string, modelId?: string } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const update = (patch: Partial<Draft>) => setDraft((old) => old ? { ...old, ...patch, error: patch.error ?? '' } : null)
  const accept = useCallback((value: CatalogSnapshot) => {
    if (!acceptsRevision(current.current?.revision ?? null, value.revision)) return
    current.current = value
    if (mounted.current) { setSnapshot(value); setUnavailable(false) }
  }, [])
  const reload = useCallback(async () => {
    try {
      const response = await shell.getAgentModelCatalog({ ...HEADER })
      if (response?.ok) accept(response.snapshot)
      else if (mounted.current) setUnavailable(true)
    } catch { if (mounted.current) setUnavailable(true) }
  }, [accept, shell])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = shell.onAgentModelChanged((event: Dict) => {
      if (current.current && Number.isSafeInteger(event?.revision) && event.revision <= current.current.revision) return
      void reload()
    })
    void reload()
    if (typeof shell.getAgentModelPresets === 'function') void shell.getAgentModelPresets().then((response: Dict) => {
      if (mounted.current && Array.isArray(response?.presets)) setPresets(response.presets)
    }).catch(() => {})
    return () => {
      mounted.current = false
      if (typeof unsubscribe === 'function') unsubscribe()
      for (const testId of pendingTests.current.values()) void Promise.resolve(shell.cancelSavedAgentModel?.({ ...TEST_HEADER, testId })).catch(() => {})
      pendingTests.current.clear()
    }
  }, [reload, shell])
  const command = async (body: Dict): Promise<boolean> => {
    if (busyRef.current || !current.current) return false
    busyRef.current = true; setBusy(true)
    try {
      const result = await shell.configureAgentModel({ ...HEADER, command: { ...body, expectedRevision: current.current.revision } })
      if (result?.ok) { await reload(); setNoticeKind('status'); setNotice('已保存。'); return true }
      if (result?.error?.code === 'MODEL_CONFIG_REVISION_CONFLICT') await reload()
      setNotice(result?.error?.code === 'MODEL_CONFIG_REVISION_CONFLICT'
        ? '配置已在其他地方更新，输入仍保留；请核对后重试。' : '这条修改未保存，请检查输入。')
      setNoticeKind('alert')
      return false
    } catch {
      await reload(); setNoticeKind('alert'); setNotice('保存结果尚未确认，请核对当前配置后继续。'); return false
    } finally { busyRef.current = false; setBusy(false) }
  }
  const open = (value: Draft, trigger: HTMLElement) => { opener.current = trigger; setDraft(value) }
  const close = () => {
    const trigger = opener.current
    setDraft(null)
    setTimeout(() => {
      if (trigger?.isConnected && trigger.getClientRects().length > 0) { trigger.focus(); return }
      const fallback = trigger?.textContent === '编辑连接'
        ? document.querySelector<HTMLElement>('.agent-model-default-summary button')
        : document.querySelector<HTMLElement>('.agent-model-profiles summary')
      fallback?.focus()
    }, 0)
  }
  const closePicker = () => { setPicker(false); setTimeout(() => pickerTrigger.current?.focus(), 0) }
  const edit = (profile: ProfileEntry, trigger: HTMLElement, modelId?: string) => {
    const model = profile.models.find((item) => item.modelId === modelId) ?? profile.models[0]
    open({ profileId: profile.profileId, label: profile.label, url: savedUrl(profile), credential: '',
      modelId: model?.modelId ?? '', capabilities: model ? capabilityDraft(model) : emptyCapabilityForm(),
      presetId: '', makeDefault: false, advanced: false, error: '' }, trigger)
  }
  const save = async () => {
    if (!draft || busyRef.current) return
    const parsed = connection(draft.url)
    const capabilities = capabilityFormToCapabilities(draft.capabilities)
    const focus = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0)
    if (!parsed) { update({ error: '请输入有效的 HTTPS API 地址。' }); focus('agent-url'); return }
    const savedCredential = current.current?.profiles.find((item) => item.profileId === draft.profileId)?.credential.present
    if (!draft.credential.trim() && !savedCredential) { update({ error: '请填写 API 密钥。' }); focus('agent-key'); return }
    if (!draft.modelId.trim()) { update({ error: '请填写模型名称。' }); focus('agent-model'); return }
    if (!capabilities) { update({ advanced: true, error: '请确认全部六项模型能力。' }); focus('maxInputTokens'); return }
    const label = draft.label.trim() || new URL(draft.url.trim()).hostname
    let profileId = draft.profileId
    const stages: string[] = []
    const step = async (body: Dict, label: string) => {
      const ok = await command(body)
      if (ok) stages.push(label)
      else update({ error: `${stages.length ? `已保存${stages.join('、')}；` : ''}${label}未保存，请核对后继续。` })
      return ok
    }
    let profile = current.current?.profiles.find((item) => item.profileId === profileId)
    if (!profile) {
      if (draft.presetId) profileId = `preset.${draft.presetId}`
      else {
        const base = deriveProfileId(label) || 'service'
        profileId = base
        for (let n = 2; current.current?.profiles.some((item) => item.profileId === profileId); n++) profileId = `${base}-${n}`
      }
      if (!(await step({ type: 'createProfile', profileId, label, ...parsed }, '连接'))) return
      update({ profileId }); profile = current.current?.profiles.find((item) => item.profileId === profileId)
    } else if (profile.label !== label || profile.httpsOrigin !== parsed.httpsOrigin || profile.basePath !== parsed.basePath) {
      if (!(await step({ type: 'updateProfile', profileId, label, ...parsed }, '连接'))) return
    }
    if (draft.credential.trim()) {
      if (!(await step({ type: 'setCredential', profileId, credential: draft.credential.trim() }, 'API 密钥'))) return
      update({ credential: '' })
    }
    const existing = current.current?.profiles.find((item) => item.profileId === profileId)?.models.find((item) => item.modelId === draft.modelId.trim())
    if (!existing) {
      if (!(await step({ type: 'addModel', profileId, modelId: draft.modelId.trim(), capabilities }, '模型'))) return
    } else if (JSON.stringify(existing.capabilities) !== JSON.stringify(capabilities)) {
      if (!(await step({ type: 'updateModel', profileId, modelId: draft.modelId.trim(), capabilities }, '模型能力'))) return
    }
    const target = current.current?.readinessByPurpose.default.target
    if (draft.makeDefault && (target?.profileId !== profileId || target.modelId !== draft.modelId.trim())) {
      if (!(await step({ type: 'assignPurpose', purpose: 'default', target: { profileId, modelId: draft.modelId.trim() } }, '默认模型'))) return
    }
    setNoticeKind('status'); setNotice(stages.length ? `已保存${stages.join('、')}。` : '设置没有变化。'); close()
  }
  const test = async (profileId: string, modelId: string) => {
    if (!current.current || busyRef.current) return
    const key = `${profileId}::${modelId}`
    if (pendingTests.current.has(key)) return
    const revision = current.current.revision
    const testId = `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    pendingTests.current.set(key, testId)
    setTests((old) => ({ ...old, [key]: { pending: true, result: null, revision } }))
    try {
      const result = await shell.testSavedAgentModel({ ...TEST_HEADER, profileId, modelId, expectedRevision: revision, testId })
      if (mounted.current && pendingTests.current.get(key) === testId) setTests((old) => ({ ...old, [key]: { pending: false, result, revision } }))
    } catch {
      if (mounted.current && pendingTests.current.get(key) === testId) setTests((old) => ({ ...old, [key]: { pending: false, result: { status: 'remote_unavailable', nextAction: 'retry' }, revision } }))
    } finally { if (pendingTests.current.get(key) === testId) pendingTests.current.delete(key) }
  }
  const cancelTest = async (key: string) => {
    const testId = pendingTests.current.get(key)
    if (!testId) return
    try {
      const result = await shell.cancelSavedAgentModel({ ...TEST_HEADER, testId })
      if (pendingTests.current.get(key) === testId) {
        pendingTests.current.delete(key)
        setTests((old) => ({ ...old, [key]: { pending: false, result,
          revision: old[key]?.revision ?? current.current?.revision ?? 0 } }))
      }
    } catch { setNoticeKind('alert'); setNotice('取消结果尚未确认，请稍后查看测试状态。') }
  }
  const pull = async (profileId: string) => {
    if (!current.current) return
    setSuggestionStatus('正在获取模型列表…')
    try {
      const result = await shell.pullAgentModelCatalog({ ...HEADER, profileId, expectedRevision: current.current.revision })
      setSuggestionStatus(result.status === 'success' ? '已获取模型列表；选择后仍需确认能力。' : '未能获取模型列表；仍可手填。')
      setSuggestions((old) => ({ ...old, [profileId]: Array.isArray(result.suggestions) ? result.suggestions.map((item: Dict) => item.modelId) : [] }))
      if (result.status === 'revision_conflict') await reload()
    } catch { setSuggestionStatus('未能获取模型列表；仍可手填。') }
  }
  if (unavailable) return <><h1>助手模型</h1><div className="group"><p role="alert">助手模型配置暂时不可用。</p><button className="secondary-btn" onClick={() => void reload()}>重试</button></div></>
  if (!snapshot) return <><h1>助手模型</h1><p className="sub">正在读取模型配置。</p></>
  const targets = modelTargets(snapshot)
  const assigned = snapshot.readinessByPurpose.default.target
  const defaultKey = assigned ? `${assigned.profileId}::${assigned.modelId}` : ''
  const selected = targets.find((item) => `${item.profileId}::${item.modelId}` === defaultKey)
  const testState = tests[defaultKey]?.revision === snapshot.revision ? tests[defaultKey] : null
  const filtered = targets.filter((item) => `${item.profileLabel} ${item.modelId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const editedProfile = draft ? snapshot.profiles.find((item) => item.profileId === draft.profileId) : null
  const modelOptions = editedProfile ? [...new Set([...(suggestions[editedProfile.profileId] ?? []), ...editedProfile.models.map((item) => item.modelId)])] : []
  return <>
    <h1>助手模型</h1><p className="sub">选择 AI 助手使用的模型，不影响字幕识别。</p>
    {notice && <p className="settings-status" role={noticeKind}>{notice}</p>}
    {draft ? <section className="group agent-model-editor" aria-label={draft.profileId ? draft.modelId ? '编辑模型服务' : '添加模型' : '新增模型服务'}>
      <h2>{draft.profileId ? draft.modelId ? '编辑模型服务' : '添加模型' : '新增模型服务'}</h2>
      {!draft.profileId && <div className="row"><label className="label" htmlFor="agent-preset">服务商</label>
        <select id="agent-preset" value={draft.presetId} disabled={busy} onChange={(event) => {
          const preset = presets.find((item) => item.presetId === event.currentTarget.value)
          if (!preset) { update({ presetId: '', label: '', url: '', modelId: '', capabilities: emptyCapabilityForm() }); return }
          const existing = snapshot.profiles.find((item) => item.profileId === `preset.${preset.presetId}`)
          if (existing) { edit(existing, opener.current ?? event.currentTarget, preset.modelId); return }
          update({ presetId: preset.presetId, label: preset.providerLabel, url: preset.httpsOrigin + preset.basePath,
            modelId: preset.modelId, capabilities: capabilityDraft(preset) })
        }}><option value="">自定义</option>{presets.map((item) => <option key={item.presetId} value={item.presetId}>{item.providerLabel}</option>)}</select></div>}
      {draft.profileId && <p className="hint">服务商：{draft.label}</p>}
      <div className="row"><label className="label" htmlFor="agent-url">API 地址</label><input id="agent-url" type="url" value={draft.url} disabled={busy} placeholder="https://api.example.com/v1" onChange={(event) => update({ url: event.currentTarget.value })} /></div>
      <div className="row"><div><label className="label" htmlFor="agent-key">API 密钥</label>{editedProfile?.credential.present && <div className="hint">{CREDENTIAL_LABELS[editedProfile.credential.scope]}；输入新值才更换。</div>}</div>
        <input id="agent-key" type="password" autoComplete="off" value={draft.credential} disabled={busy} onChange={(event) => update({ credential: event.currentTarget.value })} /></div>
      <div className="row"><label className="label" htmlFor="agent-model">模型名称</label><div className="field">
        <input id="agent-model" list="agent-model-options" value={draft.modelId} disabled={busy} onChange={(event) => {
          const modelId = event.currentTarget.value
          const saved = editedProfile?.models.find((item) => item.modelId === modelId)
          update({ modelId, capabilities: saved ? capabilityDraft(saved) : emptyCapabilityForm() })
        }} /><datalist id="agent-model-options">{modelOptions.map((item) => <option key={item} value={item} />)}</datalist>
        {editedProfile && <button className="link-btn" disabled={busy} onClick={() => void pull(editedProfile.profileId)}>获取模型列表</button>}</div></div>
      {suggestionStatus && <p role="status" className="hint">{suggestionStatus}</p>}
      {capabilityFormToCapabilities(draft.capabilities) && <p className="hint">{capabilitySummary(capabilityFormToCapabilities(draft.capabilities)!)}</p>}
      <CapabilityEditor draft={draft} change={update} busy={busy} />
      <label className="row"><span className="label">设为默认模型</span><input type="checkbox" checked={draft.makeDefault} disabled={busy} onChange={(event) => update({ makeDefault: event.currentTarget.checked })} /></label>
      {draft.error && <p className="model-error" role="alert">{draft.error}</p>}
      <div className="agent-model-actions"><button className="primary-btn" disabled={busy} onClick={() => void save()}>保存</button><button className="secondary-btn" disabled={busy} onClick={close}>取消</button></div>
    </section> : <>
      <section className="group agent-model-default-summary" aria-label="默认模型">
        <div className="row"><div><div className="label">默认模型</div><div className="hint">{selected ? `${selected.profileLabel} · ${selected.modelId}` : '尚未选择'}</div></div>
          <button className="secondary-btn" disabled={busy || targets.length === 0} aria-expanded={picker} onClick={(event) => { pickerTrigger.current = event.currentTarget; if (picker) closePicker(); else { setPicker(true); setSearch(''); setCandidate(defaultKey) } }}>选择模型</button></div>
        {picker && <div className="agent-model-picker" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closePicker() } }}><input type="search" aria-label="搜索模型" placeholder="搜索服务或模型" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setCandidate('') }} />
          <select size={Math.min(7, Math.max(2, filtered.length))} aria-label="模型列表" value={candidate} onChange={(event) => setCandidate(event.currentTarget.value)}>
            {filtered.map((item) => <option key={`${item.profileId}::${item.modelId}`} value={`${item.profileId}::${item.modelId}`}>{item.profileLabel} · {item.modelId}</option>)}</select>
          <div className="agent-model-actions"><button className="primary-btn" disabled={busy || !candidate || candidate === defaultKey} onClick={() => {
            const target = targets.find((item) => `${item.profileId}::${item.modelId}` === candidate)
            if (target) void command({ type: 'assignPurpose', purpose: 'default', target: { profileId: target.profileId, modelId: target.modelId } }).then((ok) => { if (ok) closePicker() })
          }}>设为默认</button><button className="secondary-btn" onClick={closePicker}>取消</button></div></div>}
        <p role="status" className="hint">测试状态：{testState?.pending ? '正在测试' : testState?.result ? MODEL_TEST_STATUS_LABELS[testState.result.status as keyof typeof MODEL_TEST_STATUS_LABELS] : '尚未测试'}</p>
        {testState?.result && <p className="hint">{MODEL_TEST_NEXT_ACTION_LABELS[testState.result.nextAction as keyof typeof MODEL_TEST_NEXT_ACTION_LABELS]}</p>}
        <div className="agent-model-actions">{selected && (testState?.pending
          ? <button className="secondary-btn" onClick={() => void cancelTest(defaultKey)}>取消测试</button>
          : <button className="secondary-btn" disabled={busy} onClick={() => void test(selected.profileId, selected.modelId)}>测试模型</button>)}
          {selected && <button className="secondary-btn" disabled={busy} onClick={(event) => { const profile = snapshot.profiles.find((item) => item.profileId === selected.profileId); if (profile) edit(profile, event.currentTarget, selected.modelId) }}>编辑连接</button>}</div>
      </section>
      <details className="group purpose-details"><summary>按用途指定模型</summary>{(['information_extraction', 'summary', 'analysis_planning'] as ModelPurpose[]).map((purpose) => {
        const entry = snapshot.readinessByPurpose[purpose]
        const value = entry.assignmentMode === 'direct' && entry.target ? `${entry.target.profileId}::${entry.target.modelId}` : ''
        return <div className="row purpose-row" key={purpose}><div><div className="label">{PURPOSE_LABELS[purpose]}</div><div className="hint">{ASSIGNMENT_LABELS[entry.assignmentMode]}</div></div>
          <select aria-label={`${PURPOSE_LABELS[purpose]}用途的模型`} value={value} disabled={busy} onChange={(event) => {
            const target = targets.find((item) => `${item.profileId}::${item.modelId}` === event.currentTarget.value)
            void command({ type: 'assignPurpose', purpose, target: target ? { profileId: target.profileId, modelId: target.modelId } : null })
          }}><option value="">使用默认模型</option>{targets.map((item) => <option key={`${item.profileId}::${item.modelId}`} value={`${item.profileId}::${item.modelId}`}>{item.profileLabel} · {item.modelId}</option>)}</select></div>
      })}</details>
      <details className="group agent-model-profiles"><summary>管理模型服务</summary><button className="primary-btn" disabled={busy} onClick={(event) => open({ profileId: '', label: '', url: '', credential: '', modelId: '', capabilities: emptyCapabilityForm(), presetId: '', makeDefault: !assigned, advanced: false, error: '' }, event.currentTarget)}>新增服务</button>
        <div className="resource-list">{snapshot.profiles.map((profile) => <div className="resource-row agent-model-managed" key={profile.profileId}><div><div className="label">{profile.label}</div><div className="hint">{profile.models.length} 个模型 · {CREDENTIAL_LABELS[profile.credential.scope]}</div></div>
          <div className="resource-actions"><button className="link-btn" disabled={busy} onClick={(event) => edit(profile, event.currentTarget)}>编辑</button><button className="link-btn" disabled={busy} onClick={() => setDeleteTarget({ profileId: profile.profileId })}>删除</button></div>
          {profile.models.map((model) => <div className="agent-model-managed-row" key={model.modelId}><span>{model.modelId}</span><button className="link-btn" disabled={busy} onClick={(event) => edit(profile, event.currentTarget, model.modelId)}>编辑模型</button><button className="link-btn" disabled={busy} onClick={() => setDeleteTarget({ profileId: profile.profileId, modelId: model.modelId })}>删除</button></div>)}
          <button className="link-btn" disabled={busy} onClick={(event) => open({ profileId: profile.profileId, label: profile.label, url: savedUrl(profile), credential: '', modelId: '', capabilities: emptyCapabilityForm(), presetId: '', makeDefault: false, advanced: false, error: '' }, event.currentTarget)}>添加模型</button>
          {deleteTarget?.profileId === profile.profileId && <div role="alertdialog" aria-label="确认删除模型服务"><p className="note">删除后，引用它的模型用途可能需要重新指定。</p>
            <button className="primary-btn" disabled={busy} onClick={() => void command(deleteTarget.modelId ? { type: 'removeModel', profileId: profile.profileId, modelId: deleteTarget.modelId } : { type: 'deleteProfile', profileId: profile.profileId }).then((ok) => { if (ok) setDeleteTarget(null) })}>确认删除</button>
            <button className="secondary-btn" onClick={() => setDeleteTarget(null)}>取消</button></div>}
        </div>)}</div>
      </details>
    </>}
  </>
}
