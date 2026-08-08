import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import Icons from '../ui/shared/fluent-icons'

type Pane = 'display' | 'audio' | 'asr' | 'resources' | 'about'
type ModelState = 'missing' | 'downloading' | 'verifying' | 'ready' | 'error'
type Dict = Record<string, any>

const PANES: ReadonlyArray<readonly [Pane, string]> = [
  ['display', '显示与字幕'], ['audio', '音频源'], ['asr', '语音识别'],
  ['resources', '模型资源'], ['about', '关于']
]
const MODEL_STATES: readonly ModelState[] = ['missing', 'downloading', 'verifying', 'ready', 'error']
const MODEL_LABEL: Record<ModelState, string> = {
  missing: '未安装', downloading: '正在下载', verifying: '正在校验', ready: '已就绪', error: '安装失败'
}
const MODEL_DETAIL: Record<'core' | 'refinement', Record<ModelState, string>> = {
  core: {
    missing: '需要下载实时字幕模型与语音活动检测。', downloading: '正在下载核心字幕模型资源包。',
    verifying: '正在校验并安装核心字幕模型资源包。', ready: '实时字幕模型与语音活动检测已就绪。',
    error: '核心字幕模型资源包未能完成安装，可以重试。'
  },
  refinement: {
    missing: '默认不下载；需要时请明确下载精修模型。', downloading: '正在下载精修模型；可取消，之后需明确继续下载。',
    verifying: '正在校验并安装精修模型。', ready: '精修模型已就绪；仍需再次明确开启。',
    error: '精修模型未能完成安装，可以重新下载。'
  }
}
const RESOURCE_COPY = [
  ['zipformer-bilingual-zh-en-2023-02-20', '临时字幕识别器', '优先提供低延迟临时字幕，不写入历史'],
  ['x-asr-160ms', '权威识别器', '负责首次稳定转写、历史与导出'],
  ['silero-vad', '语音活动检测', '辅助判断字幕段边界'],
  ['x-asr-offline', '离线精修识别模型', '为首次稳定转写生成独立精修稿']
] as const

function modelState (value: unknown): ModelState {
  return MODEL_STATES.includes(value as ModelState) ? value as ModelState : 'missing'
}
function progress (value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
}
function bytes (value: unknown): string {
  let amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) amount = 0
  const units = ['B', 'KiB', 'MiB', 'GiB']; let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1 }
  return `${amount.toFixed(unit === 0 || amount >= 100 ? 0 : 1)} ${units[unit]}`
}
function byteProgress (item: Dict): string { return `${bytes(item.downloadedBytes)} / ${bytes(item.totalBytes)}` }
function fallbackGroup (): Dict {
  return { state: 'missing', progress: 0, downloadedBytes: 0, totalBytes: 0, error: null, canInstall: false }
}
function safeModelErrorMessage (error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as Dict).code === 'string'
    ? String((error as Dict).code).toUpperCase() : ''
  if (/HASH|INTEGRITY|CHECKSUM|SIZE/.test(code)) return '资源校验未通过，请重新下载。'
  if (/NETWORK|DOWNLOAD|CONNECTION|HTTP/.test(code)) return '下载未完成，请检查网络后重试。'
  if (/ARCHIVE|EXTRACT|CONTENT/.test(code)) return '资源包无法安全安装，请重新下载。'
  if (/SESSION|ACTIVE|BUSY/.test(code)) return '请先停止当前字幕会话，再安装模型资源。'
  if (/ABORT|CANCEL|SHUTDOWN/.test(code)) return '安装已中断，下次可以继续下载。'
  return '模型资源未能完成安装，请重试。'
}

function Icon ({ name }: { name: string }): ReactElement {
  return <span className="button-icon" dangerouslySetInnerHTML={{ __html: Icons.iconMarkup(name) }} />
}
function Segmented ({ name, value, options, disabled, onSelect }: {
  name: string, value: unknown, options: ReadonlyArray<readonly [string | number, string]>,
  disabled?: (value: string | number) => boolean, onSelect: (value: string | number) => void
}): ReactElement {
  return <div className="seg" data-seg={name}>{options.map(([item, label]) =>
    <button key={item} className={String(item) === String(value) ? 'on' : ''}
      data-val={item} disabled={disabled?.(item) === true} onClick={() => onSelect(item)}>{label}</button>)}</div>
}
function ResourceRow ({ item, title, hint }: { item: Dict, title: string, hint: string }): ReactElement {
  const state = modelState(item.state); const percent = Math.round(progress(item.progress) * 100)
  return <div className="resource-row" data-resource-id={item.id} data-state={state}>
    <div><div className="label">{title}</div><div className="hint">{hint}</div></div>
    <div className="resource-status"><span data-field="state">{state === 'downloading' || state === 'verifying' ? `${MODEL_LABEL[state]} · ${percent}%` : MODEL_LABEL[state]}</span>
      <span className="hint" data-field="bytes">{byteProgress(item)}</span></div>
  </div>
}
function ModelSummary ({ kind, group, children }: { kind: 'core' | 'refinement', group: Dict, children: ReactElement }): ReactElement {
  const state = modelState(group.state); const percent = Math.round(progress(group.progress) * 100)
  return <div className={`group model-summary${kind === 'refinement' ? ' refinement-summary' : ''}`}>
    <div className="row"><div><div className="label">{kind === 'core' ? '核心字幕模型资源包' : '精修模型资源'}</div>
      <div className="hint model-state" id={kind === 'core' ? 'modelOverallState' : 'refinementOverallState'} aria-live="polite">{MODEL_DETAIL[kind][state]}</div></div>{children}</div>
    <div className="model-progress" id={kind === 'core' ? 'modelProgress' : 'refinementProgress'} role="progressbar"
      aria-label={kind === 'core' ? '模型资源总进度' : '精修模型资源进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span id={kind === 'core' ? 'modelProgressBar' : 'refinementProgressBar'} style={{ width: `${percent}%` }} /></div>
    <div className="model-progress-meta"><span id={kind === 'core' ? 'modelProgressText' : 'refinementProgressText'}>{percent}%</span>
      <span id={kind === 'core' ? 'modelBytes' : 'refinementBytes'}>{byteProgress(group)}</span></div>
    <p className="model-error" id={kind === 'core' ? 'modelError' : 'refinementError'} role="alert" hidden={group.error == null}>
      {group.error == null ? '' : safeModelErrorMessage(group.error)}</p>
  </div>
}

export function SettingsView (): ReactElement {
  const shell = window.shell
  if (!shell) throw new Error('settings preload bridge is missing')
  const [cfg, setCfg] = useState<Dict | null>(null)
  const [runtime, setRuntime] = useState<Dict | null>(null)
  const [models, setModels] = useState<Dict | null>(null)
  const [pane, setPane] = useState<Pane>('display')
  const [notice, setNotice] = useState('')
  const [presetPending, setPresetPending] = useState(false)
  const [sourcePending, setSourcePending] = useState(false)
  const [corePending, setCorePending] = useState(false)
  const [refinementPending, setRefinementPending] = useState(false)
  const [preferencePending, setPreferencePending] = useState(false)
  const titlebar = useRef<HTMLElement>(null)
  const queuedPatch = useRef<Dict>({})
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reflectConfig = useCallback((next: Dict) => {
    setCfg(next)
    document.documentElement.dataset.theme = next.theme === 'auto' ? (next.systemDark ? 'dark' : 'light') : next.theme
    if (next.refinementPreferenceFallback === true) setNotice('精修模型不可用，已关闭精修偏好。请重新下载模型后再开启。')
  }, [])
  const refreshConfig = useCallback(async () => { try { reflectConfig(await shell.getConfig()) } catch { /* keep last authority */ } }, [reflectConfig, shell])
  const refreshModels = useCallback(async () => {
    try { const next = await shell.getModelStatus(); if (next?.schemaVersion === 1) setModels(next) }
    catch { setNotice('无法读取模型资源状态，请稍后重试。') }
  }, [shell])
  const savePatch = useCallback(async (patch: Dict): Promise<boolean> => {
    try {
      const result = await shell.setConfig(patch)
      if (!result?.ok) { setNotice(result?.message || '设置未保存'); await refreshConfig(); return false }
      setNotice(''); return true
    } catch { setNotice('设置未保存'); await refreshConfig(); return false }
  }, [refreshConfig, shell])
  const flushPatch = useCallback(() => {
    if (patchTimer.current) clearTimeout(patchTimer.current)
    patchTimer.current = null; const patch = queuedPatch.current; queuedPatch.current = {}
    if (Object.keys(patch).length > 0) void savePatch(patch)
  }, [savePatch])
  const previewPatch = useCallback((patch: Dict) => {
    setCfg((current) => current ? { ...current, ...patch } : current)
    queuedPatch.current = { ...queuedPatch.current, ...patch }
    if (patchTimer.current) clearTimeout(patchTimer.current)
    patchTimer.current = setTimeout(flushPatch, 120)
  }, [flushPatch])

  useEffect(() => {
    if (!cfg) return
    document.documentElement.dataset.theme = cfg.theme === 'auto'
      ? (cfg.systemDark ? 'dark' : 'light')
      : cfg.theme
  }, [cfg?.systemDark, cfg?.theme])

  useEffect(() => {
    const disposers = [
      shell.onConfig(reflectConfig), shell.onSnapshot((next: Dict) => setRuntime((current) => !current || next.revision >= current.revision ? next : current)),
      shell.onModelStatus((next: Dict) => { if (next?.schemaVersion === 1) setModels(next) }),
      shell.onNavigate((next: unknown) => { if (PANES.some(([name]) => name === next)) setPane(next as Pane) })
    ]
    void refreshConfig(); void shell.getSnapshot().then(setRuntime).catch(() => {}); void refreshModels()
    const beforeUnload = () => flushPatch(); window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload); flushPatch(); disposers.forEach((dispose) => { if (typeof dispose === 'function') dispose() }) }
  }, [flushPatch, reflectConfig, refreshConfig, refreshModels, shell])
  useEffect(() => {
    const drag = window.ManualWindowDrag; if (!drag || !titlebar.current) return
    const controller = drag.bindManualWindowDrag({ handle: titlebar.current,
      canStart: (event: Event) => !drag.isInteractiveDragEvent(event), onStart: () => shell.dragStart(), onEnd: () => shell.dragEnd() })
    return () => controller.end()
  }, [shell])

  const core = models?.core ?? fallbackGroup(); const refinement = models?.refinement ?? fallbackGroup()
  const sessionActive = runtime?.sessionId != null; const runtimeKnown = runtime !== null
  const coreBusy = ['downloading', 'verifying'].includes(core.state); const refinementBusy = ['downloading', 'verifying'].includes(refinement.state)
  const anyBusy = coreBusy || refinementBusy
  const resources = useMemo(() => new Map((models?.resources ?? []).map((item: Dict) => [item.id, item])), [models])
  const resource = (id: string): Dict => resources.get(id) ?? { id, ...fallbackGroup() }
  const profiles: string[] = runtime?.capabilities?.availableProfiles ?? []
  const limitation = runtime?.capabilities?.limitations?.find((item: Dict) => item.capability === 'start')
  const asrNote = profiles.length === 0 ? (limitation?.message ?? '当前没有可用识别档位。') : '识别档位由本机已就绪的模型决定，不可用的档位已停用。'
  const preferenceText = cfg == null ? '正在读取全局精修偏好。' : cfg.refinementEnabled === true
    ? '已启用；只影响未来新会话，当前会话保持开始时的选择。' : refinement.state === 'ready'
      ? '模型已就绪；请明确开启，设置仅影响未来新会话。' : '默认关闭；模型缺失时尝试开启不会下载，请先下载精修模型。'

  const choosePreset = async (preset: string, sourceChange = false) => {
    sourceChange ? setSourcePending(true) : setPresetPending(true); setNotice(sourceChange ? '正在切换监听模式…' : '正在保存场景…')
    try { const result = await shell.selectPreset(preset); if (!result?.ok) { setNotice(result?.message || '设置未保存'); await refreshConfig() } else setNotice('') }
    catch { setNotice(sourceChange ? '监听模式未保存' : '场景未保存'); await refreshConfig() }
    finally { sourceChange ? setSourcePending(false) : setPresetPending(false) }
  }
  const install = async (kind: 'core' | 'refinement') => {
    kind === 'core' ? setCorePending(true) : setRefinementPending(true)
    try {
      const result = kind === 'core' ? await shell.installModelResources() : await shell.installRefinementModel()
      const returned = result?.schemaVersion === 1 ? result : result?.value?.schemaVersion === 1 ? result.value : null
      if (returned) setModels(returned)
      if (result?.ok === false) setNotice(kind === 'core' ? '安装请求未能完成，请稍后重试。' : (result?.error?.message || '精修模型下载请求未能完成。'))
    } catch { setNotice(kind === 'core' ? '安装请求未能完成，请稍后重试。' : '精修模型下载请求未能完成，请稍后重试。') }
    finally { await refreshModels(); kind === 'core' ? setCorePending(false) : setRefinementPending(false) }
  }
  const cancelRefinement = async () => {
    setRefinementPending(true)
    try { const result = await shell.cancelModelInstall(); setNotice(result?.ok ? '已取消精修模型下载；需要时请明确继续下载。' : (result?.error?.message || '取消下载请求未能完成。')) }
    catch { setNotice('取消下载请求未能完成。') } finally { await refreshModels(); setRefinementPending(false) }
  }
  const setPreference = async (enabled: boolean) => {
    setPreferencePending(true)
    try { const result = await shell.setRefinementPreference(enabled); if (!result?.ok) { setNotice(result?.error?.message || '精修偏好未保存。'); await refreshConfig() } else { reflectConfig(result.value); setNotice('') } }
    catch { setNotice('精修偏好未保存。'); await refreshConfig() } finally { setPreferencePending(false) }
  }

  const coreDisabled = !runtimeKnown || corePending || sessionActive || anyBusy || core.state === 'ready' || models?.canInstall !== true
  const refinementDisabled = !runtimeKnown || refinementPending || sessionActive || anyBusy || refinement.state === 'ready' || models?.canInstallRefinement !== true
  const installLabel = (kind: 'core' | 'refinement'): string => {
    const group = kind === 'core' ? core : refinement; const pending = kind === 'core' ? corePending : refinementPending
    if (!runtimeKnown) return '正在读取'; if (sessionActive && !['downloading', 'verifying', 'ready'].includes(group.state)) return '请先停止会话'
    if (pending || ['downloading', 'verifying'].includes(group.state)) return group.state === 'verifying' ? '正在校验' : '正在下载'
    if (group.state === 'ready') return '已就绪'; if (group.state === 'error') return kind === 'core' ? '重试下载' : '重新下载'
    if (kind === 'refinement' && group.downloadedBytes > 0) return '继续下载'
    return kind === 'core' ? '下载核心模型' : '下载精修模型'
  }

  return <>
    <header className="titlebar" ref={titlebar}><div className="tb-title">Live Subtitle Agent · 设置</div>
      <div className="settings-status" id="settingsStatus" role="status" aria-live="polite">{notice}</div>
      <button className="tb-close" id="close" title="关闭" aria-label="关闭" onClick={() => shell.closeSettings()}><Icon name="close" /></button></header>
    <section className="onboarding" id="onboarding" hidden={cfg?.onboardingCompleted === true} aria-labelledby="onboardingTitle"><div className="onboarding-panel">
      <p className="onboarding-step">首次设置</p><h1 id="onboardingTitle">你主要想听哪一种声音？</h1><p className="sub">先选一个起点，之后仍可在“音频源”中调整。</p>
      <div className="preset-grid"><button className="preset-card" data-preset="meeting" disabled={presetPending} onClick={() => void choosePreset('meeting')}><strong>会议字幕</strong><span>默认监听系统音频，适合线上会议与视频。</span></button>
        <button className="preset-card" data-preset="dictation" disabled={presetPending} onClick={() => void choosePreset('dictation')}><strong>个人听写</strong><span>默认监听麦克风，适合口述记录与写作。</span></button></div>
      <p className="onboarding-note">选择前不会启用麦克风或系统音频。模型未就绪时，识别功能会保持不可用。</p></div></section>
    <div className="layout"><nav className="nav" aria-label="设置类别">{PANES.map(([name, label]) => <button key={name} className={`nav-item${pane === name ? ' active' : ''}`} data-pane={name} aria-current={pane === name ? 'page' : undefined} onClick={() => setPane(name)}>{label}</button>)}</nav>
      <main className="content">
        <section className={`pane${pane === 'display' ? ' active' : ''}`} data-pane="display"><h1>显示与字幕</h1><p className="sub">调整字幕条的外观，改动实时生效。</p><div className="group">
          <div className="row"><div className="label">字号</div><Segmented name="fontsize" value={cfg?.fontSize} options={[[24, '小'], [30, '中'], [38, '大']]} onSelect={(value) => previewPatch({ fontSize: Number(value) })} /></div>
          <div className="row"><div className="label">主题</div><Segmented name="theme" value={cfg?.theme} options={[['light', '浅色'], ['auto', '自动'], ['dark', '深色']]} onSelect={(value) => previewPatch({ theme: value })} /></div>
          <div className="row"><div className="label">字幕背景不透明度 <span className="hint" id="opacityVal">{Number(cfg?.opacity ?? .86).toFixed(2)}</span></div><input type="range" id="opacity" min="0" max="1" step="0.01" value={cfg?.opacity ?? .86} aria-label="字幕背景不透明度" onChange={(event) => previewPatch({ opacity: Number(event.currentTarget.value) })} /></div>
          <div className="row"><div className="label">工具条背景不透明度 <span className="hint" id="toolbarOpacityVal">{Number(cfg?.toolbarOpacity ?? .82).toFixed(2)}</span></div><input type="range" id="toolbarOpacity" min="0" max="1" step="0.01" value={cfg?.toolbarOpacity ?? .82} aria-label="工具条背景不透明度" onChange={(event) => previewPatch({ toolbarOpacity: Number(event.currentTarget.value) })} /></div>
          <div className="row"><div className="label">背景颜色 <span className="hint" id="barColorVal">{cfg?.barColor || '跟随主题'}</span></div><div className="field"><input type="color" id="barColor" value={cfg?.barColor || '#0e202c'} aria-label="背景颜色" onChange={(event) => previewPatch({ barColor: event.currentTarget.value })} /><button className="link-btn" id="barColorReset" disabled={!cfg?.barColor} onClick={() => previewPatch({ barColor: null })}>跟随主题</button></div></div>
          <div className="row"><div className="label">圆角 <span className="hint" id="radiusVal">{cfg?.radius ?? 10} px</span></div><input type="range" id="radius" min="6" max="16" step="1" value={cfg?.radius ?? 10} aria-label="字幕圆角" onChange={(event) => previewPatch({ radius: Number(event.currentTarget.value) })} /></div>
        </div></section>
        <section className={`pane${pane === 'audio' ? ' active' : ''}`} data-pane="audio"><h1>音频源</h1><p className="sub">选择本次会话要监听的一路声音。</p><div className="group"><div className="row"><div><div className="label">监听模式</div><div className="hint source-hint">一次只监听一路；活动会话需停止后才能切换。</div></div>
          <div className="seg source-choice" id="audioSourceChoice" role="radiogroup" aria-label="监听模式">{[['loopback', 'meeting', '系统音频'], ['mic', 'dictation', '麦克风']].map(([source, preset, label]) => <button key={source} data-source={source} data-preset={preset} role="radio" aria-checked={cfg?.[source] === true} className={cfg?.[source] === true ? 'on' : ''} disabled={sessionActive || sourcePending} onClick={() => void choosePreset(preset, true)}>{label}</button>)}</div></div></div>
          <p className="note">两种来源均保留支持，但不会在同一会话中并发采集。系统音频不代表特定说话人。</p></section>
        <section className={`pane${pane === 'asr' ? ' active' : ''}`} data-pane="asr"><h1>语音识别</h1><p className="sub">本地离线语音识别。</p><div className="group"><div className="row"><div className="label">字幕延迟</div>
          <Segmented name="latency" value={cfg?.latency} options={[[160, '极速'], [480, '均衡'], [960, '精准']]} disabled={(value) => !profiles.includes(({ 160: 'fast', 480: 'balanced', 960: 'accurate' } as Dict)[value])} onSelect={(value) => void savePatch({ latency: Number(value) })} /></div></div><p className="note" id="asrNote">{asrNote}</p></section>
        <section className={`pane${pane === 'resources' ? ' active' : ''}`} data-pane="resources"><h1>模型资源</h1><p className="sub">核心字幕模型资源包与可选精修模型资源分别管理。</p>
          <ModelSummary kind="core" group={core}><button className="primary-btn" id="modelInstallButton" disabled={coreDisabled} aria-busy={corePending || coreBusy} onClick={() => void install('core')}>{installLabel('core')}</button></ModelSummary>
          <div className="resource-list" aria-label="核心字幕模型资源明细">{RESOURCE_COPY.slice(0, 3).map(([id, title, hint]) => <ResourceRow key={id} item={resource(id)} title={title} hint={hint} />)}</div>
          <ModelSummary kind="refinement" group={refinement}><div className="resource-actions"><button className="secondary-btn" id="refinementCancelButton" hidden={!refinementBusy} disabled={sessionActive || models?.canCancelInstall !== true} onClick={() => void cancelRefinement()}>取消下载</button>
            <button className="primary-btn" id="refinementInstallButton" disabled={refinementDisabled} aria-busy={refinementPending || refinementBusy} onClick={() => void install('refinement')}>{installLabel('refinement')}</button></div></ModelSummary>
          <div className="resource-list" aria-label="精修模型资源明细"><ResourceRow item={resource(RESOURCE_COPY[3][0])} title={RESOURCE_COPY[3][1]} hint={RESOURCE_COPY[3][2]} /></div>
          <div className="group refinement-preference"><div className="row"><div><div className="label">为未来新会话启用精修</div><div className="hint" id="refinementPreferenceState">{preferenceText}</div></div><label className="switch"><input id="refinementPreferenceToggle" type="checkbox" checked={cfg?.refinementEnabled === true} disabled={cfg == null || refinementBusy || preferencePending} aria-describedby="refinementPreferenceState" onChange={(event) => void setPreference(event.currentTarget.checked)} /><span>启用</span></label></div></div>
          <p className="note">这些资源只服务于本地字幕识别，不包含 Agent、翻译或大语言模型。核心字幕模型资源包包含临时字幕识别器、权威识别器与语音活动检测；临时字幕不会进入历史或导出。精修模型默认不下载；取消后保留合法已下载部分，只有明确点击“继续下载”才会续传。安装完成后仍需再次明确开启，且只影响未来新会话。</p></section>
        <section className={`pane${pane === 'about' ? ' active' : ''}`} data-pane="about"><h1>关于</h1><p className="sub">Live Subtitle Agent · 骨架 v0.1.0</p><p className="note">本地两遍 ASR 已接入；模型缺失时保持不可用，不会伪造字幕。</p></section>
      </main></div>
  </>
}
