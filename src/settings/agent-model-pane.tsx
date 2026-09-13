import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  MODEL_PURPOSES, PURPOSE_LABELS, ASSIGNMENT_LABELS, READINESS_LABELS, CREDENTIAL_LABELS, REMOTE_STATUS_LABELS,
  MODEL_TEST_STATUS_LABELS, MODEL_TEST_NEXT_ACTION_LABELS,
  deriveProfileId, isValidProfileId, modelTargets, emptyCapabilityForm, capabilityFormToCapabilities, capabilitySummary,
  acceptsRevision, profileIdTaken,
  type CatalogSnapshot, type ModelPurpose, type CapabilityForm, type ModelEntry, type ModelTarget,
  type ProfileEntry, type ReadinessEntry, type RemoteStatus, type ModelPreset, type ModelTestStatus
} from './agent-model-view-model'

type Dict = Record<string, any>

const CONTRACT_HEADER = Object.freeze({ contractId: 'agent-model-ui', contractVersion: '1.0.0' })
const TEST_CONTRACT_HEADER = Object.freeze({ contractId: 'agent-model-test-ui', contractVersion: '1.0.0' })
const presetProfileId = (presetId: string) => `preset.${presetId}`
const HELP_LINKS: Record<string, string> = {
  'deepseek-api-key': 'https://platform.deepseek.com/api_keys',
  'openai-api-key': 'https://platform.openai.com/api-keys',
  'qwen-beijing-api-key': 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'
}

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

type CommandRunner = (command: Dict) => Promise<boolean>

function capabilityFormFrom (capabilities: ModelEntry['capabilities']): CapabilityForm {
  return {
    maxInputTokens: String(capabilities.maxInputTokens), maxOutputTokens: String(capabilities.maxOutputTokens),
    supportsToolCalling: capabilities.supportsToolCalling, supportsStructuredOutput: capabilities.supportsStructuredOutput,
    supportsStreaming: capabilities.supportsStreaming, usageReporting: capabilities.usageReporting
  }
}

function WizardStepLabel ({ step, current, children }: { step: number, current: number, children: string }): ReactElement {
  return <li className={step === current ? 'on' : step < current ? 'done' : ''}>{children}</li>
}

function wizardResumeStep (snapshot: CatalogSnapshot, preset: ModelPreset | undefined): number {
  if (!preset) return 1
  const profile = snapshot.profiles.find((entry) => entry.profileId === presetProfileId(preset.presetId))
  if (!profile) return 1
  if (!profile.credential.present) return 2
  return profile.models.some((model) => model.modelId === preset.modelId) ? 4 : 3
}

function FirstRunWizard ({ snapshot, presets, commandPending, runCommand, testSavedModel, onDone }: {
  snapshot: CatalogSnapshot, presets: ModelPreset[], commandPending: boolean, runCommand: CommandRunner,
  testSavedModel: (profileId: string, modelId: string) => Promise<Dict>, onDone: () => void
}): ReactElement | null {
  const initialPreset = presets[0]
  const initialProfile = initialPreset
    ? snapshot.profiles.find((entry) => entry.profileId === presetProfileId(initialPreset.presetId))
    : undefined
  const initialModel = initialProfile?.models.find((model) => model.modelId === initialPreset?.modelId)
  const [step, setStep] = useState(() => wizardResumeStep(snapshot, initialPreset))
  const [selectedId, setSelectedId] = useState(presets[0]?.presetId ?? '')
  const [profileId, setProfileId] = useState(initialProfile?.profileId ?? '')
  const [credential, setCredential] = useState('')
  const [modelForm, setModelForm] = useState<CapabilityForm & { modelId: string }>(() => initialModel
    ? { modelId: initialModel.modelId, ...capabilityFormFrom(initialModel.capabilities) }
    : { modelId: initialPreset?.modelId ?? '', ...(initialPreset ? capabilityFormFrom(initialPreset.capabilities) : emptyCapabilityForm()) })
  const [testPending, setTestPending] = useState(false)
  const [testResult, setTestResult] = useState<Dict | null>(null)

  const selected = presets.find((preset) => preset.presetId === selectedId) ?? presets[0]
  useEffect(() => {
    if (!selected) return
    const profile = snapshot.profiles.find((entry) => entry.profileId === presetProfileId(selected.presetId))
    const saved = profile?.models.find((model) => model.modelId === selected.modelId)
    setProfileId(profile?.profileId ?? '')
    setStep(wizardResumeStep(snapshot, selected))
    setModelForm(saved
      ? { modelId: saved.modelId, ...capabilityFormFrom(saved.capabilities) }
      : { modelId: selected.modelId, ...capabilityFormFrom(selected.capabilities) })
  }, [selectedId])
  if (!selected) return null

  const stepOne = async () => {
    const target = presetProfileId(selected.presetId)
    const existing = snapshot.profiles.find((profile) => profile.profileId === target)
    const ok = await runCommand(existing
      ? { type: 'updateProfile', profileId: target, label: selected.providerLabel, httpsOrigin: selected.httpsOrigin, basePath: selected.basePath }
      : { type: 'createProfile', profileId: target, label: selected.providerLabel, httpsOrigin: selected.httpsOrigin, basePath: selected.basePath })
    if (ok) { setProfileId(target); setStep(2) }
  }
  const stepTwo = async () => {
    if (credential.trim() === '' || profileId === '') return
    const ok = await runCommand({ type: 'setCredential', profileId, credential: credential.trim() })
    setCredential('')
    if (ok) setStep(3)
  }
  const stepThree = async () => {
    const capabilities = capabilityFormToCapabilities(modelForm)
    if (!capabilities || profileId === '') return
    const existing = snapshot.profiles.find((profile) => profile.profileId === profileId)?.models.find((model) => model.modelId === modelForm.modelId.trim())
    const ok = await runCommand(existing
      ? { type: 'updateModel', profileId, modelId: modelForm.modelId.trim(), capabilities }
      : { type: 'addModel', profileId, modelId: modelForm.modelId.trim(), capabilities })
    if (ok) setStep(4)
  }
  const startTest = async () => {
    if (profileId === '' || modelForm.modelId.trim() === '') return
    setTestPending(true)
    try { setTestResult(await testSavedModel(profileId, modelForm.modelId.trim())) } finally { setTestPending(false) }
  }
  const assignDefault = async () => {
    if (profileId === '' || modelForm.modelId.trim() === '') return
    if (await runCommand({ type: 'assignPurpose', purpose: 'default', target: { profileId, modelId: modelForm.modelId.trim() } })) onDone()
  }

  return <section className="agent-model-wizard group" aria-labelledby="agentModelWizardTitle">
    <p className="eyebrow">首次配置</p>
    <h2 id="agentModelWizardTitle">用四步配置 Agent 模型</h2>
    <p className="hint wizard-intro">连接和 API 密钥分别保存；模型确认后才会进入配置。测试可以跳过，但默认用途需要明确设置。</p>
    <ol className="wizard-steps" aria-label="模型配置步骤">
      <WizardStepLabel step={1} current={step}>连接</WizardStepLabel>
      <WizardStepLabel step={2} current={step}>API 密钥</WizardStepLabel>
      <WizardStepLabel step={3} current={step}>确认模型</WizardStepLabel>
      <WizardStepLabel step={4} current={step}>测试与默认用途</WizardStepLabel>
    </ol>

    {step === 1 && <div data-wizard-step="connection">
      <div className="preset-choice" role="radiogroup" aria-label="选择模型服务">
        {presets.map((preset) => <button type="button" key={`${preset.presetId}@${preset.version}`} className={preset.presetId === selected.presetId ? 'preset-card on' : 'preset-card'} aria-pressed={preset.presetId === selected.presetId} disabled={commandPending}
          onClick={() => setSelectedId(preset.presetId)}><strong>{preset.providerLabel}</strong><span>{preset.region === 'cn-beijing' ? '中国内地北京服务' : 'OpenAI-compatible 服务'}</span><span>{preset.modelId}</span></button>)}
      </div>
      <div className="row"><div><div className="label">API 服务器地址</div><div className="hint">{selected.httpsOrigin}</div></div><code>{selected.basePath}</code></div>
      <p className="hint">预设由产品维护，应用上限与来源日期可展开查看；不会自动写入模型。</p>
      <button type="button" className="primary-btn" disabled={commandPending} onClick={() => void stepOne()}>保存连接并继续</button>
      <details className="wizard-details"><summary>查看预设详情</summary><p>来源日期：{selected.sourceSnapshotDate} · 模型：{selected.modelId} · 地域：{selected.region === 'cn-beijing' ? '中国内地北京' : '未指定地域'}</p><p>API 密钥帮助：<a href={HELP_LINKS[selected.helpId]} target="_blank" rel="noreferrer">打开服务商说明</a></p></details>
    </div>}

    {step === 2 && <div data-wizard-step="credential">
      <p className="label">为 {selected.providerLabel} 设置 API 密钥</p>
      <p className="hint">密钥只由主进程保存，既有密钥不会回显。当前步骤提交后才写入密钥。</p>
      <div className="row"><input type="password" autoComplete="off" aria-label="首次配置 API 密钥" value={credential} disabled={commandPending} onChange={(event) => setCredential(event.currentTarget.value)} /><a className="link-btn" href={HELP_LINKS[selected.helpId]} target="_blank" rel="noreferrer">在哪里获取？</a></div>
      <button type="button" className="primary-btn" disabled={commandPending || credential.trim() === ''} onClick={() => void stepTwo()}>保存 API 密钥并继续</button>
    </div>}

    {step === 3 && <div data-wizard-step="model">
      <p className="label">确认模型能力</p>
      <p className="hint">这些是本应用的配置上限，不代表服务商公布的模型极限。</p>
      <div className="row"><div className="label">模型名称（Model ID）</div><input aria-label="首次配置模型名称" value={modelForm.modelId} disabled={commandPending} onChange={(event) => setModelForm((form) => ({ ...form, modelId: event.currentTarget.value }))} /></div>
      <details open className="wizard-details"><summary>六项能力</summary><CapabilityFields form={modelForm} disabled={commandPending} onChange={(patch) => setModelForm((form) => ({ ...form, ...patch }))} /></details>
      <button type="button" className="primary-btn" disabled={commandPending || canSubmitModel(modelForm, { models: [], profileId, label: '', profileRevision: 1, catalogRevision: 0, httpsOrigin: '', basePath: '', templateId: null, templateSuggestion: null, credential: { present: false, scope: 'absent' } }) === false} onClick={() => void stepThree()}>确认并保存模型</button>
    </div>}

    {step === 4 && <div data-wizard-step="test">
      <p className="label">测试与默认用途</p>
      <p className="hint">测试只发一次固定请求，不会创建正式 Agent 交互或保存响应正文。</p>
      <div className="wizard-test-result" role={testResult ? (testResult.status === 'success' ? 'status' : 'alert') : undefined}>
        {testResult && <><span>{MODEL_TEST_STATUS_LABELS[testResult.status as ModelTestStatus] ?? '模型测试结束'}</span>{testResult.nextAction && MODEL_TEST_NEXT_ACTION_LABELS[testResult.nextAction as keyof typeof MODEL_TEST_NEXT_ACTION_LABELS] && <span className="hint">下一步：{MODEL_TEST_NEXT_ACTION_LABELS[testResult.nextAction as keyof typeof MODEL_TEST_NEXT_ACTION_LABELS]}</span>}</>}
      </div>
      <div className="resource-actions"><button type="button" className="secondary-btn" disabled={testPending || commandPending} onClick={() => void startTest()}>{testPending ? '测试中…' : '测试模型'}</button><button type="button" className="primary-btn" disabled={testPending || commandPending} onClick={() => void assignDefault()}>设置为默认模型</button></div>
      <button type="button" className="link-btn" disabled={testPending || commandPending} onClick={() => void assignDefault()}>跳过测试并设置默认用途</button>
    </div>}
    <button type="button" className="link-btn wizard-exit" disabled={testPending || commandPending} onClick={onDone}>退出首次配置</button>
  </section>
}

function ModelTestControl ({ profile, model, state, disabled, onTest, onCancel }: {
  profile: ProfileEntry, model: ModelEntry, state: { pending: boolean, result: Dict | null, cancelRequested?: boolean }, disabled: boolean,
  onTest: () => void, onCancel: () => void
}): ReactElement {
  const result = state.result
  return <div className="model-test-control">
    {state.pending
      ? <button type="button" className="secondary-btn" disabled={disabled || state.cancelRequested === true} onClick={onCancel}>{state.cancelRequested ? '正在取消测试' : '取消测试'}</button>
      : <button type="button" className="link-btn" disabled={disabled} onClick={onTest}>测试模型</button>}
    {result && <span className={result.status === 'success' ? 'test-result success' : 'test-result'} role={result.status === 'success' ? 'status' : 'alert'}>{MODEL_TEST_STATUS_LABELS[result.status as ModelTestStatus] ?? '模型测试结束'}{result.nextAction && MODEL_TEST_NEXT_ACTION_LABELS[result.nextAction as keyof typeof MODEL_TEST_NEXT_ACTION_LABELS] ? ` · ${MODEL_TEST_NEXT_ACTION_LABELS[result.nextAction as keyof typeof MODEL_TEST_NEXT_ACTION_LABELS]}` : ''}</span>}
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
  const [presets, setPresets] = useState<ModelPreset[]>([])
  const [testByModel, setTestByModel] = useState<Record<string, { pending: boolean, result: Dict | null, testId: string | null }>>({})
  const [newProfileOpen, setNewProfileOpen] = useState(() => typeof shell.getAgentModelPresets !== 'function')
  const [wizardRequested, setWizardRequested] = useState(false)
  const [wizardDismissed, setWizardDismissed] = useState(false)

  const revisionRef = useRef<number | null>(null)
  const reloadQueuedRef = useRef(false)
  const mountedRef = useRef(true)
  const pendingTestIdsRef = useRef<Map<string, string>>(new Map())

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
    if (typeof shell.getAgentModelPresets === 'function') {
      void shell.getAgentModelPresets().then((response: Dict) => {
        if (mountedRef.current && Array.isArray(response?.presets)) setPresets(response.presets as ModelPreset[])
      }).catch(() => {})
    }
    return () => {
      mountedRef.current = false
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof shell.cancelSavedAgentModel === 'function') {
        for (const testId of pendingTestIdsRef.current.values()) {
          void Promise.resolve(shell.cancelSavedAgentModel({ ...TEST_CONTRACT_HEADER, testId })).catch(() => {})
        }
      }
      pendingTestIdsRef.current.clear()
    }
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

  const testSavedModel = useCallback(async (profileId: string, modelId: string): Promise<Dict> => {
    const key = `${profileId}::${modelId}`
    const testId = `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (pendingTestIdsRef.current.has(key)) return { ok: false, status: 'invalid_request', nextAction: 'edit_connection' }
    pendingTestIdsRef.current.set(key, testId)
    setTestByModel((current) => ({ ...current, [key]: { pending: true, result: null, testId, cancelRequested: false } }))
    if (typeof shell.testSavedAgentModel !== 'function' || revisionRef.current === null) {
      const result = { ok: false, status: 'remote_unavailable', nextAction: 'retry' }
      pendingTestIdsRef.current.delete(key)
      setTestByModel((current) => ({ ...current, [key]: { pending: false, result, testId: null, cancelRequested: false } }))
      return result
    }
    try {
      const result = await shell.testSavedAgentModel({ ...TEST_CONTRACT_HEADER, profileId, modelId, expectedRevision: revisionRef.current, testId })
      if (mountedRef.current && pendingTestIdsRef.current.get(key) === testId) setTestByModel((current) => ({ ...current, [key]: { pending: false, result, testId: null, cancelRequested: false } }))
      return result
    } catch {
      const result = { ok: false, status: 'remote_unavailable', nextAction: 'retry' }
      if (mountedRef.current && pendingTestIdsRef.current.get(key) === testId) setTestByModel((current) => ({ ...current, [key]: { pending: false, result, testId: null, cancelRequested: false } }))
      return result
    } finally {
      if (pendingTestIdsRef.current.get(key) === testId) pendingTestIdsRef.current.delete(key)
    }
  }, [shell])

  const cancelSavedModel = useCallback(async (profileId: string, modelId: string) => {
    const key = `${profileId}::${modelId}`
    const testId = pendingTestIdsRef.current.get(key)
    if (!testId || typeof shell.cancelSavedAgentModel !== 'function') return
    if (mountedRef.current) setTestByModel((state) => ({
      ...state, [key]: { ...(state[key] ?? { pending: true, result: null, testId }), pending: true, testId, cancelRequested: true }
    }))
    try {
      await shell.cancelSavedAgentModel({ ...TEST_CONTRACT_HEADER, testId })
    } catch {
      if (mountedRef.current && pendingTestIdsRef.current.get(key) === testId) {
        setTestByModel((state) => ({
          ...state, [key]: { ...(state[key] ?? { pending: true, result: null, testId }), pending: true, testId, cancelRequested: false }
        }))
      }
    }
  }, [shell])

  if (unavailable) {
    return <>
      <h1>Agent 模型</h1>
      <p className="sub">为 Agent 配置模型，用于问答、摘要和分析。实时字幕无需配置这里的模型。</p>
      <div className="group">
        <p className="note" role="alert">Agent 模型配置暂时不可用。</p>
        <button className="secondary-btn" onClick={() => void reload()}>重试</button>
      </div>
    </>
  }

  if (!snapshot) {
    return <>
      <h1>Agent 模型</h1>
      <p className="sub">正在读取 Agent 模型配置。</p>
    </>
  }

  const targets = modelTargets(snapshot)
  const derivedId = deriveProfileId(newProfile.label)
  const derivedTaken = derivedId !== '' && profileIdTaken(snapshot, derivedId)
  const derivedReserved = derivedId.startsWith('preset.')
  const expanded = newProfile.customId || derivedId === '' || derivedTaken || derivedReserved
  const effectiveId = expanded ? newProfile.profileId : derivedId
  const reservedPresetId = effectiveId.startsWith('preset.')
  const idValid = isValidProfileId(effectiveId) && !reservedPresetId && !profileIdTaken(snapshot, effectiveId)
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

  const hasSavedModel = snapshot.profiles.some((profile) => profile.models.length > 0)
  const showWizard = presets.length > 0 && (wizardRequested || (!hasSavedModel && !wizardDismissed))
  const defaultReadiness = snapshot.readinessByPurpose.default
  const defaultTarget = defaultReadiness.target
    ? targets.find((target) => target.profileId === defaultReadiness.target!.profileId && target.modelId === defaultReadiness.target!.modelId)
    : null

  return <>
    <h1>Agent 模型</h1>
    <p className="sub">为 Agent 配置模型，用于问答、摘要和分析。实时字幕无需配置这里的模型。</p>

    {notice !== '' && <p className="settings-status" role={noticeKind === 'alert' ? 'alert' : 'status'} aria-live="polite">{notice}</p>}

    {hasSavedModel && <div className="group agent-model-default-summary" aria-label="当前默认模型">
      <div className="label">当前默认模型</div>
      {defaultReadiness.target && defaultTarget
        ? <><div>{defaultTarget.profileLabel} · {defaultTarget.modelId}</div>
          <div className="hint">{ASSIGNMENT_LABELS[defaultReadiness.assignmentMode]} · 普通请求：{READINESS_LABELS[defaultReadiness.singleShot]} · Agent Loop：{READINESS_LABELS[defaultReadiness.agentLoop]}</div></>
        : <div className="hint">默认用途尚未设置模型，请在下方明确选择。</div>}
    </div>}

    {showWizard && <FirstRunWizard snapshot={snapshot} presets={presets} commandPending={commandPending} runCommand={runCommand} testSavedModel={testSavedModel} onDone={() => { setWizardRequested(false); setWizardDismissed(true); void reload() }} />}

    {!showWizard && presets.length > 0 && <button type="button" className="secondary-btn agent-model-preset-launcher"
      onClick={() => { setWizardDismissed(false); setWizardRequested(true) }}>使用服务预设快速配置</button>}

    <div className="group agent-model-profiles" aria-label="模型服务列表">
      <p className="hint agent-model-profiles-help">一个模型服务可以配置多个模型，共用该服务配置中的 API 密钥。</p>
      {snapshot.profiles.length === 0 && <p className="note">还没有服务配置。</p>}
      {snapshot.profiles.map((profile) => {
        const ui = getUi(profile.profileId)
        return <div key={profile.profileId} className="agent-model-profile-card" data-profile-id={profile.profileId}>
          {ui.editingConnection
            ? <div className="group">
                <div className="row"><div className="label">服务名称</div>
                  <input aria-label="服务名称" value={ui.connectionForm.label} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, label: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">API 服务器地址</div>
                  <input aria-label="API 服务器地址" value={ui.connectionForm.httpsOrigin} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, httpsOrigin: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">API 基础路径</div>
                  <input aria-label="API 基础路径" value={ui.connectionForm.basePath} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { connectionForm: { ...ui.connectionForm, basePath: event.currentTarget.value } })} /></div>
                <div className="row"><div className="label">配置标识</div><span className="hint">{profile.profileId}（不可修改）</span></div>
                <button className="primary-btn" disabled={commandPending ||
                  ui.connectionForm.label.trim() === '' || ui.connectionForm.httpsOrigin.trim() === '' || ui.connectionForm.basePath.trim() === ''}
                  onClick={() => void updateConnection(profile.profileId)}>保存修改</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { editingConnection: false })}>取消</button>
              </div>
            : <div className="row">
                <div><div className="label">{profile.label}</div>
                  <div className="hint">{profile.httpsOrigin}{profile.basePath}</div></div>
                <button className="link-btn" disabled={commandPending}
                onClick={() => updateUi(profile.profileId, { editingConnection: true, connectionForm: { label: profile.label, httpsOrigin: profile.httpsOrigin, basePath: profile.basePath } })}>编辑连接</button>
              </div>}

          <div className="row">
            <div><div className="label">API 密钥（API Key）</div><div className="hint">{CREDENTIAL_LABELS[profile.credential.scope]}</div></div>
            <div className="field">
              <input type="password" autoComplete="off" aria-label={`为 ${profile.label} 设置新的 API 密钥`}
                value={ui.credentialDraft} disabled={commandPending}
                onChange={(event) => updateUi(profile.profileId, { credentialDraft: event.currentTarget.value })} />
              <button className="secondary-btn" disabled={commandPending || ui.credentialDraft.trim() === ''}
                onClick={() => void setCredential(profile.profileId)}>设置新的 API 密钥</button>
              <button className="link-btn" disabled={commandPending || !profile.credential.present}
                onClick={() => void clearCredential(profile.profileId)}>清除 API 密钥</button>
            </div>
          </div>

          {profile.templateSuggestion && <div className="group">
            <p className="hint">官方模板建议（{profile.templateSuggestion.sourceSnapshotDate}）：{profile.templateSuggestion.modelId} · 能力为非权威建议，需确认后提交</p>
            <button className="link-btn" onClick={() => applySuggestion(profile.profileId, { modelId: profile.templateSuggestion!.modelId, capabilitySuggestion: profile.templateSuggestion!.capabilitySuggestion })}>用这条建议填写</button>
          </div>}

          <div className="resource-list" aria-label={`${profile.label} 的模型列表`}>
            {profile.models.length === 0 && <p className="note">还没有模型。</p>}
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
                    <div><div className="label">模型名称（Model ID）：{model.modelId}</div><div className="hint">{capabilitySummary(model.capabilities)}</div></div>
                    <div className="resource-actions">
                      <ModelTestControl profile={profile} model={model} state={testByModel[`${profile.profileId}::${model.modelId}`] ?? { pending: false, result: null, testId: null }} disabled={commandPending} onTest={() => void testSavedModel(profile.profileId, model.modelId)} onCancel={() => void cancelSavedModel(profile.profileId, model.modelId)} />
                      <button className="link-btn" disabled={commandPending} onClick={() => openEditModel(profile.profileId, model)}>修改</button>
                      <button className="link-btn" disabled={commandPending} onClick={() => updateUi(profile.profileId, { confirmDeleteModelId: model.modelId })}>删除</button>
                    </div>
                  </>}
              {ui.confirmDeleteModelId === model.modelId && <div className="group" role="alertdialog" aria-label={`确认删除 ${model.modelId}`}>
                <p className="note">这个模型不再可选；指向它的模型用途会变成未配置。</p>
                <button className="primary-btn" disabled={commandPending} onClick={() => void removeModel(profile.profileId, model.modelId)}>确认删除</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { confirmDeleteModelId: null })}>取消</button>
              </div>}
            </div>)}
          </div>

          {ui.addModelOpen
            ? <div className="group">
                <div className="row"><div className="label">模型名称（Model ID）</div>
                  <input aria-label="模型名称（Model ID）" value={ui.addModelForm.modelId} disabled={commandPending}
                    onChange={(event) => updateUi(profile.profileId, { addModelForm: { ...ui.addModelForm, modelId: event.currentTarget.value } })} /></div>
                <CapabilityFields form={ui.addModelForm} disabled={commandPending}
                  onChange={(patch) => updateUi(profile.profileId, { addModelForm: { ...ui.addModelForm, ...patch } })} />
                <button className="primary-btn" disabled={commandPending || !canSubmitModel(ui.addModelForm, profile)}
                  onClick={() => void addModel(profile.profileId)}>保存模型</button>
                <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { addModelOpen: false })}>取消</button>
              </div>
            : <button className="secondary-btn" disabled={commandPending}
                onClick={() => updateUi(profile.profileId, { addModelOpen: true, addModelForm: { modelId: '', ...emptyCapabilityForm() } })}>添加模型</button>}

          <div className="row">
            <button className="secondary-btn" disabled={ui.remotePending} onClick={() => void pullRemote(profile.profileId)}>从服务器获取模型建议</button>
            <button className="link-btn" disabled={commandPending} onClick={() => updateUi(profile.profileId, { confirmDelete: true })}>删除服务配置</button>
          </div>
          {ui.remoteStatus && <div className="group">
            <p className="hint" role={ui.remoteStatus === 'success' ? 'status' : 'alert'}>{REMOTE_STATUS_LABELS[ui.remoteStatus]}</p>
            {ui.remoteSuggestions.map((suggestion) => <div key={suggestion.modelId} className="resource-row">
              <div className="label">{suggestion.modelId}</div>
              <button className="link-btn" onClick={() => applySuggestion(profile.profileId, suggestion)}>用这条建议填写</button>
            </div>)}
          </div>}
          {ui.confirmDelete && <div className="group" role="alertdialog" aria-label={`确认删除 ${profile.label}`}>
            <p className="note">这份服务配置、它的模型列表和 API 密钥都会移除；使用它的模型用途会变成未配置；已经开始的运行保留原有模型身份。</p>
            <button className="primary-btn" disabled={commandPending} onClick={() => void deleteProfile(profile.profileId)}>确认删除</button>
            <button className="secondary-btn" onClick={() => updateUi(profile.profileId, { confirmDelete: false })}>取消</button>
          </div>}
        </div>
      })}
    </div>

    <details className="agent-model-new-profile" open={newProfileOpen} onToggle={(event) => setNewProfileOpen(event.currentTarget.open)}>
      <summary>添加模型服务</summary>
      <div className="group">
      <div className="label">添加模型服务</div>
      <div className="row"><div className="label">服务名称</div>
        <input aria-label="新服务名称" value={newProfile.label} disabled={commandPending}
          onChange={(event) => { const label = event.currentTarget.value; setNewProfile((current) => ({ ...current, label })) }} /></div>
      <div className="row"><div className="label">API 服务器地址</div>
        <input aria-label="新服务 API 服务器地址" placeholder="https://api.example.com" value={newProfile.httpsOrigin} disabled={commandPending}
          onChange={(event) => { const httpsOrigin = event.currentTarget.value; setNewProfile((current) => ({ ...current, httpsOrigin })) }} /></div>
      <div className="row"><div className="label">API 基础路径</div>
        <input aria-label="新服务 API 基础路径" value={newProfile.basePath} disabled={commandPending}
          onChange={(event) => { const basePath = event.currentTarget.value; setNewProfile((current) => ({ ...current, basePath })) }} /></div>
      <div className="row"><div className="label">配置标识</div>
        {expanded
          ? <div className="field">
              <input aria-label="配置标识" value={newProfile.profileId} disabled={commandPending}
                onChange={(event) => { const profileId = event.currentTarget.value; setNewProfile((current) => ({ ...current, customId: true, profileId })) }} />
              {!newProfile.customId && <span className="hint">自动推导的标识不可用，请手动填写。</span>}
              {newProfile.customId && reservedPresetId && <span className="hint">该标识由服务预设保留，请换一个配置标识。</span>}
            </div>
          : <div className="field"><span className="hint" data-field="derived-profile-id">{derivedId}</span>
              <button type="button" className="link-btn" disabled={commandPending}
                onClick={() => setNewProfile((current) => ({ ...current, customId: true, profileId: derivedId }))}>自定义标识</button>
            </div>}
      </div>
      <button className="primary-btn" disabled={!canCreate} onClick={() => void createProfile()}>添加模型服务</button>
      </div>
    </details>

    <div className="group agent-model-purposes" aria-label="模型用途">
      <div className="label">模型用途</div>
      <PurposeRow purpose="default" entry={snapshot.readinessByPurpose.default} targets={targets}
        disabled={commandPending} onAssign={assignPurpose} />
      <details className="purpose-details">
        <summary>按用途指定模型</summary>
        {MODEL_PURPOSES.filter((purpose) => purpose !== 'default').map((purpose) => <PurposeRow key={purpose} purpose={purpose}
          entry={snapshot.readinessByPurpose[purpose]} targets={targets} disabled={commandPending} onAssign={assignPurpose} />)}
      </details>
    </div>

    <p className="note">这里的设置只影响 Agent 使用的模型；API 密钥一旦设置不会在界面上回显，只能设置新值或清除。</p>
  </>
}
