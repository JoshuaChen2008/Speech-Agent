import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  MODEL_PURPOSES, PURPOSE_LABELS, ASSIGNMENT_LABELS, READINESS_LABELS, CREDENTIAL_LABELS, REMOTE_STATUS_LABELS,
  deriveProfileId, isValidProfileId, modelTargets, emptyCapabilityForm, capabilityFormToCapabilities, capabilitySummary,
  acceptsRevision, profileIdTaken,
  type CatalogSnapshot, type ModelPurpose, type CapabilityForm, type ModelEntry, type ModelTarget,
  type ProfileEntry, type ReadinessEntry, type RemoteStatus
} from './agent-model-view-model'

type Dict = Record<string, any>

const CONTRACT_HEADER = Object.freeze({ contractId: 'agent-model-ui', contractVersion: '1.0.0' })

interface ProfileUiState {
  addModelOpen: boolean
  addModelForm: CapabilityForm & { modelId: string }
  editingModelId: string | null
  editModelForm: CapabilityForm
  credentialDraft: string
  confirmDelete: boolean
  confirmDeleteModelId: string | null
  editingConnection: boolean
  connectionForm: { label: string, httpsOrigin: string, basePath: string }
  remotePending: boolean
  remoteStatus: RemoteStatus | null
  remoteSuggestions: Array<{ modelId: string, capabilitySuggestion: Dict | null }>
}

const DEFAULT_PROFILE_UI: ProfileUiState = Object.freeze({
  addModelOpen: false,
  addModelForm: { modelId: '', ...emptyCapabilityForm() },
  editingModelId: null,
  editModelForm: emptyCapabilityForm(),
  credentialDraft: '',
  confirmDelete: false,
  confirmDeleteModelId: null,
  editingConnection: false,
  connectionForm: { label: '', httpsOrigin: '', basePath: '' },
  remotePending: false,
  remoteStatus: null,
  remoteSuggestions: []
}) as ProfileUiState

function BoolChoice ({ label, value, disabled, onChange }: {
  label: string, value: boolean | null, disabled?: boolean, onChange: (next: boolean) => void
}): ReactElement {
  return <div className="row capability-row">
    <div className="label">{label}</div>
    <div className="seg" role="radiogroup" aria-label={label}>
      <button type="button" className={value === true ? 'on' : ''} aria-pressed={value === true}
        disabled={disabled} onClick={() => onChange(true)}>支持</button>
      <button type="button" className={value === false ? 'on' : ''} aria-pressed={value === false}
        disabled={disabled} onClick={() => onChange(false)}>不支持</button>
    </div>
  </div>
}

function CapabilityFields ({ form, disabled, onChange }: {
  form: CapabilityForm, disabled?: boolean, onChange: (patch: Partial<CapabilityForm>) => void
}): ReactElement {
  return <>
    <div className="row"><div className="label">最大输入 token</div>
      <input type="number" min={1} step={1} aria-label="最大输入 token" value={form.maxInputTokens} disabled={disabled}
        onChange={(event) => onChange({ maxInputTokens: event.currentTarget.value })} /></div>
    <div className="row"><div className="label">最大输出 token</div>
      <input type="number" min={1} step={1} aria-label="最大输出 token" value={form.maxOutputTokens} disabled={disabled}
        onChange={(event) => onChange({ maxOutputTokens: event.currentTarget.value })} /></div>
    <BoolChoice label="工具调用" value={form.supportsToolCalling} disabled={disabled} onChange={(v) => onChange({ supportsToolCalling: v })} />
    <BoolChoice label="结构化输出" value={form.supportsStructuredOutput} disabled={disabled} onChange={(v) => onChange({ supportsStructuredOutput: v })} />
    <BoolChoice label="流式输出" value={form.supportsStreaming} disabled={disabled} onChange={(v) => onChange({ supportsStreaming: v })} />
    <BoolChoice label="用量上报" value={form.usageReporting} disabled={disabled} onChange={(v) => onChange({ usageReporting: v })} />
  </>
}

function canSubmitModel (form: { modelId: string } & CapabilityForm, profile: ProfileEntry, excludeModelId?: string): boolean {
  const modelId = form.modelId.trim()
  if (modelId === '') return false
  if (profile.models.some((model) => model.modelId === modelId && model.modelId !== excludeModelId)) return false
  return capabilityFormToCapabilities(form) !== null
}

function PurposeRow ({ purpose, entry, targets, disabled, onAssign }: {
  purpose: ModelPurpose, entry: ReadinessEntry, targets: ModelTarget[], disabled: boolean,
  onAssign: (purpose: ModelPurpose, target: { profileId: string, modelId: string } | null) => void
}): ReactElement {
  const value = entry.target ? `${entry.target.profileId}::${entry.target.modelId}` : ''
  const targetLabel = entry.target
    ? targets.find((t) => t.profileId === entry.target!.profileId && t.modelId === entry.target!.modelId)?.profileLabel ?? entry.target.profileId
    : null
  return <div className="row purpose-row" data-purpose={purpose}>
    <div>
      <div className="label">{PURPOSE_LABELS[purpose]}</div>
      <div className="hint">{ASSIGNMENT_LABELS[entry.assignmentMode]}{entry.target ? ` · ${targetLabel} · ${entry.target.modelId}` : ''}</div>
      <div className="hint">普通请求：{READINESS_LABELS[entry.singleShot]} · Agent Loop：{READINESS_LABELS[entry.agentLoop]}</div>
    </div>
    <select aria-label={`${PURPOSE_LABELS[purpose]}用途的模型`} value={value} disabled={disabled}
      onChange={(event) => {
        const raw = event.currentTarget.value
        if (raw === '') { onAssign(purpose, null); return }
        const [profileId, modelId] = raw.split('::')
        onAssign(purpose, { profileId, modelId })
      }}>
      <option value="">{purpose === 'default' ? '未配置' : '回落到默认'}</option>
      {targets.map((t) => <option key={`${t.profileId}::${t.modelId}`} value={`${t.profileId}::${t.modelId}`}>{t.profileLabel} · {t.modelId}</option>)}
    </select>
  </div>
}

export function AgentModelPane ({ shell }: { shell: Dict }): ReactElement {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'status' | 'alert'>('status')
  const [commandPending, setCommandPending] = useState(false)
  const [uiByProfile, setUiByProfile] = useState<Record<string, ProfileUiState>>({})
  const [newProfile, setNewProfile] = useState({ label: '', httpsOrigin: '', basePath: '/v1', customId: false, profileId: '' })

  const revisionRef = useRef<number | null>(null)
  const reloadQueuedRef = useRef(false)
  const mountedRef = useRef(true)

  const getUi = useCallback((profileId: string): ProfileUiState => uiByProfile[profileId] ?? DEFAULT_PROFILE_UI, [uiByProfile])
  const updateUi = useCallback((profileId: string, patch: Partial<ProfileUiState>) => {
    setUiByProfile((current) => ({ ...current, [profileId]: { ...DEFAULT_PROFILE_UI, ...current[profileId], ...patch } }))
  }, [])

  const applySnapshot = useCallback((incoming: CatalogSnapshot) => {
    if (!acceptsRevision(revisionRef.current, incoming.revision)) return
    revisionRef.current = incoming.revision
    setSnapshot(incoming)
    setUnavailable(false)
  }, [])

  const reload = useCallback(async () => {
    try {
      const response = await shell.getAgentModelCatalog({ ...CONTRACT_HEADER })
      if (!mountedRef.current) return
      if (response.ok) applySnapshot(response.snapshot)
      else setUnavailable(true)
    } catch { if (mountedRef.current) setUnavailable(true) }
  }, [applySnapshot, shell])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = shell.onAgentModelChanged((event: Dict) => {
      if (revisionRef.current !== null && event.revision <= revisionRef.current) return
      if (reloadQueuedRef.current) return
      reloadQueuedRef.current = true
      void reload().finally(() => { reloadQueuedRef.current = false })
    })
    void reload()
    return () => { mountedRef.current = false; if (typeof unsubscribe === 'function') unsubscribe() }
  }, [reload, shell])

  const runCommand = useCallback(async (command: Dict): Promise<boolean> => {
    if (revisionRef.current === null) return false
    setCommandPending(true)
    try {
      const response = await shell.configureAgentModel({
        ...CONTRACT_HEADER,
        command: { ...command, expectedRevision: revisionRef.current }
      })
      if (response.ok) {
        setNoticeKind('status'); setNotice('已保存。')
        await reload()
        return true
      }
      if (response.error.code === 'MODEL_CONFIG_REVISION_CONFLICT') {
        setNoticeKind('alert'); setNotice('配置已在别处更新，本次没有写入。已重新载入权威配置，你的输入仍保留。')
        await reload()
      } else {
        setNoticeKind('alert'); setNotice('输入无效，本次没有写入任何内容。')
      }
      return false
    } catch {
      setNoticeKind('alert'); setNotice('本次操作未能完成，请重试。')
      return false
    } finally {
      setCommandPending(false)
    }
  }, [reload, shell])

  if (unavailable) {
    return <>
      <h1>Agent 模型配置档案</h1>
      <p className="sub">管理 Agent 使用的模型连接、model 清单与凭据。这些设置不影响字幕系统。</p>
      <div className="group">
        <p className="note" role="alert">Agent 模型配置暂时不可用。</p>
        <button className="secondary-btn" onClick={() => void reload()}>重试</button>
      </div>
    </>
  }

  if (!snapshot) {
    return <>
      <h1>Agent 模型配置档案</h1>
      <p className="sub">正在读取 Agent 模型配置。</p>
    </>
  }

  const targets = modelTargets(snapshot)
  const derivedId = deriveProfileId(newProfile.label)
  const derivedTaken = derivedId !== '' && profileIdTaken(snapshot, derivedId)
  const expanded = newProfile.customId || derivedId === '' || derivedTaken
  const effectiveId = expanded ? newProfile.profileId : derivedId
  const idValid = isValidProfileId(effectiveId) && !profileIdTaken(snapshot, effectiveId)
  const canCreate = !commandPending && idValid &&
    newProfile.label.trim() !== '' && newProfile.httpsOrigin.trim() !== '' && newProfile.basePath.trim() !== ''

  const createProfile = async () => {
    const ok = await runCommand({
      type: 'createProfile', profileId: effectiveId,
      label: newProfile.label.trim(), httpsOrigin: newProfile.httpsOrigin.trim(), basePath: newProfile.basePath.trim()
    })
    if (ok) setNewProfile({ label: '', httpsOrigin: '', basePath: '/v1', customId: false, profileId: '' })
  }
  const updateConnection = async (profileId: string) => {
    const ui = getUi(profileId)
    const ok = await runCommand({
      type: 'updateProfile', profileId,
      label: ui.connectionForm.label.trim(), httpsOrigin: ui.connectionForm.httpsOrigin.trim(), basePath: ui.connectionForm.basePath.trim()
    })
    if (ok) updateUi(profileId, { editingConnection: false })
  }
  const deleteProfile = async (profileId: string) => { await runCommand({ type: 'deleteProfile', profileId }) }
  const addModel = async (profileId: string) => {
    const ui = getUi(profileId)
    const capabilities = capabilityFormToCapabilities(ui.addModelForm)
    if (!capabilities) return
    const ok = await runCommand({ type: 'addModel', profileId, modelId: ui.addModelForm.modelId.trim(), capabilities })
    if (ok) updateUi(profileId, { addModelOpen: false, addModelForm: { modelId: '', ...emptyCapabilityForm() } })
  }
  const updateModel = async (profileId: string, modelId: string) => {
    const ui = getUi(profileId)
    const capabilities = capabilityFormToCapabilities(ui.editModelForm)
    if (!capabilities) return
    const ok = await runCommand({ type: 'updateModel', profileId, modelId, capabilities })
    if (ok) updateUi(profileId, { editingModelId: null })
  }
  const removeModel = async (profileId: string, modelId: string) => {
    const ok = await runCommand({ type: 'removeModel', profileId, modelId })
    if (ok) updateUi(profileId, { confirmDeleteModelId: null })
  }
  const setCredential = async (profileId: string) => {
    const value = getUi(profileId).credentialDraft.trim()
    updateUi(profileId, { credentialDraft: '' })
    if (value === '') return
    await runCommand({ type: 'setCredential', profileId, credential: value })
  }
  const clearCredential = async (profileId: string) => { await runCommand({ type: 'clearCredential', profileId }) }
  const assignPurpose = (purpose: ModelPurpose, target: { profileId: string, modelId: string } | null) => {
    void runCommand({ type: 'assignPurpose', purpose, target })
  }
  const openEditModel = (profileId: string, model: ModelEntry) => {
    updateUi(profileId, {
      editingModelId: model.modelId,
      editModelForm: {
        maxInputTokens: String(model.capabilities.maxInputTokens),
        maxOutputTokens: String(model.capabilities.maxOutputTokens),
        supportsToolCalling: model.capabilities.supportsToolCalling,
        supportsStructuredOutput: model.capabilities.supportsStructuredOutput,
        supportsStreaming: model.capabilities.supportsStreaming,
        usageReporting: model.capabilities.usageReporting
      }
    })
  }
  const applySuggestion = (profileId: string, suggestion: { modelId: string, capabilitySuggestion: Dict | null }) => {
    const cap = suggestion.capabilitySuggestion
    updateUi(profileId, {
      addModelOpen: true,
      addModelForm: {
        modelId: suggestion.modelId,
        maxInputTokens: '', maxOutputTokens: '',
        supportsToolCalling: cap?.supportsToolCalling ?? null,
        supportsStructuredOutput: cap?.supportsStructuredOutput ?? null,
        supportsStreaming: cap?.supportsStreaming ?? null,
        usageReporting: cap?.usageReporting ?? null
      }
    })
  }
  const pullRemote = async (profileId: string) => {
    updateUi(profileId, { remotePending: true })
    try {
      const response = await shell.pullAgentModelCatalog({
        ...CONTRACT_HEADER, profileId, expectedRevision: revisionRef.current
      })
      updateUi(profileId, { remoteStatus: response.status, remoteSuggestions: response.suggestions, remotePending: false })
      if (response.status === 'revision_conflict') await reload()
    } catch {
      updateUi(profileId, { remoteStatus: 'remote_unavailable', remoteSuggestions: [], remotePending: false })
    }
  }

  return <>
    <h1>Agent 模型配置档案</h1>
    <p className="sub">管理 Agent 使用的模型连接、model 清单与凭据。这些设置不影响字幕系统。</p>

    {notice !== '' && <p className="settings-status" role={noticeKind === 'alert' ? 'alert' : 'status'} aria-live="polite">{notice}</p>}

    <div className="group agent-model-profiles" aria-label="配置档案列表">
      {snapshot.profiles.length === 0 && <p className="note">还没有配置档案。</p>}
      {snapshot.profiles.map((profile) => {
        const ui = getUi(profile.profileId)
        return <div key={profile.profileId} className="agent-model-profile-card" data-profile-id={profile.profileId}>
          {ui.editingConnection
            ? <div className="group">
                <div className="row"><div className="label">名称</div>
                  <input aria-label="名称" value={ui.connectionForm.label} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, label: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">服务器地址</div>
                  <input aria-label="服务器地址" value={ui.connectionForm.httpsOrigin} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, httpsOrigin: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">接口前缀</div>
                  <input aria-label="接口前缀" value={ui.connectionForm.basePath} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, basePath: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">档案标识</div><span className="hint">{profile.profileId}（不可修改）</span></div>
                <button className="primary-btn" disabled={commandPending ||
                  ui.connectionForm.label.trim() === '' || ui.connectionForm.httpsOrigin.trim() === '' || ui.connectionForm.basePath.trim() === ''}
                  onClick={() => void updateConnection(profile.profileId)}>保存修改</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { editingConnection: false })}>取消</button>
              </div>
            : <div className="row">
                <div><div className="label">{profile.label}</div>
                  <div className="hint">{profile.httpsOrigin}{profile.basePath} · 档案标识 {profile.profileId}</div></div>
                <button className="link-btn" disabled={commandPending}
                  onClick={() => updateUi(profile.profileId, { editingConnection: true, connectionForm: { label: profile.label, httpsOrigin: profile.httpsOrigin, basePath: profile.basePath } })}>修改档案</button>
              </div>}

          <div className="row">
            <div><div className="label">凭据</div><div className="hint">{CREDENTIAL_LABELS[profile.credential.scope]}</div></div>
            <div className="field">
              <input type="password" autoComplete="off" aria-label={`为 ${profile.label} 设置新凭据`}
                value={ui.credentialDraft} disabled={commandPending}
                onChange={(event) => updateUi(profile.profileId, { credentialDraft: event.currentTarget.value })} />
              <button className="secondary-btn" disabled={commandPending || ui.credentialDraft.trim() === ''}
                onClick={() => void setCredential(profile.profileId)}>设置新凭据</button>
              <button className="link-btn" disabled={commandPending || !profile.credential.present}
                onClick={() => void clearCredential(profile.profileId)}>清除凭据</button>
            </div>
          </div>

          {profile.templateSuggestion && <div className="group">
            <p className="hint">官方模板建议（{profile.templateSuggestion.sourceSnapshotDate}）：{profile.templateSuggestion.modelId} · 能力为非权威建议，需确认后提交</p>
            <button className="link-btn" onClick={() => applySuggestion(profile.profileId, { modelId: profile.templateSuggestion!.modelId, capabilitySuggestion: profile.templateSuggestion!.capabilitySuggestion })}>用这条建议填写</button>
          </div>}

          <div className="resource-list" aria-label={`${profile.label} 的 model 清单`}>
            {profile.models.length === 0 && <p className="note">还没有 model。</p>}
            {profile.models.map((model) => <div key={model.modelId} className="resource-row" data-model-id={model.modelId}>
              {ui.editingModelId === model.modelId
                ? <div className="group">
                    <CapabilityFields form={ui.editModelForm} disabled={commandPending}
                      onChange={(patch) => updateUi(profile.profileId, { editModelForm: { ...ui.editModelForm, ...patch } })} />
                    <button className="primary-btn" disabled={commandPending || capabilityFormToCapabilities(ui.editModelForm) === null}
                      onClick={() => void updateModel(profile.profileId, model.modelId)}>保存修改</button>
                    <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { editingModelId: null })}>取消</button>
                  </div>
                : <>
                    <div><div className="label">{model.modelId}</div><div className="hint">{capabilitySummary(model.capabilities)}</div></div>
                    <div className="resource-actions">
                      <button className="link-btn" disabled={commandPending} onClick={() => openEditModel(profile.profileId, model)}>修改</button>
                      <button className="link-btn" disabled={commandPending} onClick={() => updateUi(profile.profileId, { confirmDeleteModelId: model.modelId })}>删除</button>
                    </div>
                  </>}
              {ui.confirmDeleteModelId === model.modelId && <div className="group" role="alertdialog" aria-label={`确认删除 ${model.modelId}`}>
                <p className="note">这个 model 不再可选；指向它的模型用途会变成未配置。</p>
                <button className="primary-btn" disabled={commandPending} onClick={() => void removeModel(profile.profileId, model.modelId)}>确认删除</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { confirmDeleteModelId: null })}>取消</button>
              </div>}
            </div>)}
          </div>

          {ui.addModelOpen
            ? <div className="group">
                <div className="row"><div className="label">model ID</div>
                  <input aria-label="model ID" value={ui.addModelForm.modelId} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { addModelForm: { ...ui.addModelForm, modelId: event.currentTarget.value } })} /></div>
                <CapabilityFields form={ui.addModelForm} disabled={commandPending}
                  onChange={(patch) => updateUi(profile.profileId, { addModelForm: { ...ui.addModelForm, ...patch } })} />
                <button className="primary-btn" disabled={commandPending || !canSubmitModel(ui.addModelForm, profile)}
                  onClick={() => void addModel(profile.profileId)}>保存 model</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { addModelOpen: false })}>取消</button>
              </div>
            : <button className="secondary-btn" disabled={commandPending}
                onClick={() => updateUi(profile.profileId, { addModelOpen: true, addModelForm: { modelId: '', ...emptyCapabilityForm() } })}>添加 model</button>}

          <div className="row">
            <button className="secondary-btn" disabled={ui.remotePending} onClick={() => void pullRemote(profile.profileId)}>从服务器获取模型建议</button>
            <button className="link-btn" disabled={commandPending} onClick={() => updateUi(profile.profileId, { confirmDelete: true })}>删除档案</button>
          </div>
          {ui.remoteStatus && <div className="group">
            <p className="hint" role={ui.remoteStatus === 'success' ? 'status' : 'alert'}>{REMOTE_STATUS_LABELS[ui.remoteStatus]}</p>
            {ui.remoteSuggestions.map((suggestion) => <div key={suggestion.modelId} className="resource-row">
              <div className="label">{suggestion.modelId}</div>
              <button className="link-btn" onClick={() => applySuggestion(profile.profileId, suggestion)}>用这条建议填写</button>
            </div>)}
          </div>}
          {ui.confirmDelete && <div className="group" role="alertdialog" aria-label={`确认删除 ${profile.label}`}>
            <p className="note">这份连接、它的 model 清单和凭据都会移除；使用它的模型用途会变成未配置；已经开始的运行保留原有模型身份。</p>
            <button className="primary-btn" disabled={commandPending} onClick={() => void deleteProfile(profile.profileId)}>确认删除</button>
            <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { confirmDelete: false })}>取消</button>
          </div>}
        </div>
      })}
    </div>

    <div className="group agent-model-new-profile">
      <div className="label">新建配置档案</div>
      <div className="row"><div className="label">名称</div>
        <input aria-label="新档案名称" value={newProfile.label} disabled={commandPending}
          onChange={(event) => { const label = event.currentTarget.value; setNewProfile((current) => ({ ...current, label })) }} /></div>
      <div className="row"><div className="label">服务器地址</div>
        <input aria-label="新档案服务器地址" placeholder="https://api.example.com" value={newProfile.httpsOrigin} disabled={commandPending}
          onChange={(event) => { const httpsOrigin = event.currentTarget.value; setNewProfile((current) => ({ ...current, httpsOrigin })) }} /></div>
      <div className="row"><div className="label">接口前缀</div>
        <input aria-label="新档案接口前缀" value={newProfile.basePath} disabled={commandPending}
          onChange={(event) => { const basePath = event.currentTarget.value; setNewProfile((current) => ({ ...current, basePath })) }} /></div>
      <div className="row"><div className="label">档案标识</div>
        {expanded
          ? <div className="field">
              <input aria-label="档案标识" value={newProfile.profileId} disabled={commandPending}
                onChange={(event) => { const profileId = event.currentTarget.value; setNewProfile((current) => ({ ...current, customId: true, profileId })) }} />
              {!newProfile.customId && <span className="hint">自动推导的标识不可用，请手动填写。</span>}
            </div>
          : <div className="field"><span className="hint" data-field="derived-profile-id">{derivedId}</span>
              <button type="button" className="link-btn" disabled={commandPending}
                onClick={() => setNewProfile((current) => ({ ...current, customId: true, profileId: derivedId }))}>自定义标识</button>
            </div>}
      </div>
      <button className="primary-btn" disabled={!canCreate} onClick={() => void createProfile()}>创建配置档案</button>
    </div>

    <div className="group agent-model-purposes" aria-label="模型用途">
      <div className="label">模型用途</div>
      {MODEL_PURPOSES.map((purpose) => <PurposeRow key={purpose} purpose={purpose}
        entry={snapshot.readinessByPurpose[purpose]} targets={targets} disabled={commandPending} onAssign={assignPurpose} />)}
    </div>

    <p className="note">这里的设置只影响 Agent 使用的模型；凭据一旦设置不会在界面上回显，只能设置新值或清除。</p>
  </>
}
