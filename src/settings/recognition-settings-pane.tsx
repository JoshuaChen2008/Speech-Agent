import { useEffect, useState, type ReactElement } from 'react'

const ERRORS: Record<string, string> = {
  NLS_SESSION_ACTIVE: '请先停止当前字幕会话。',
  NLS_SETTINGS_CONFLICT: '设置已变化，请重新打开本页后保存。',
  NLS_DISCLOSURE_REQUIRED: '请填写 AppKey 并确认音频上传说明。',
  NLS_AUTH_FAILED: '凭据验证失败，请检查 RAM AccessKey 和权限。',
  NLS_CLOCK_INVALID: '系统时间不准确，无法验证身份。请校正系统时间后重试。',
  NLS_CREDENTIAL_CLEANUP_REQUIRED: '配置已写入，但旧加密凭据尚未清理，识别暂不可启动。请重启应用重试清理。',
  NLS_TOKEN_TIMEOUT: 'Token 请求超时，请检查网络后重试。',
  NLS_INVALID_SETTINGS: '请检查项目配置和凭据格式。'
}

export function RecognitionSettingsPane ({ shell, active }: { shell: any, active: boolean }): ReactElement {
  const [saved, setSaved] = useState<any>(null)
  const [strategy, setStrategy] = useState('local-only')
  const [appKey, setAppKey] = useState('')
  const [modelLabel, setModelLabel] = useState('')
  const [disclosure, setDisclosure] = useState(false)
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  function hydrate (value: any): void {
    setSaved(value); setStrategy(value.strategy); setAppKey(value.appKey)
    setModelLabel(value.modelLabel); setDisclosure(value.cloudDisclosureAccepted)
  }
  useEffect(() => {
    let live = true
    if (typeof shell.getRecognitionSettings !== 'function') return
    void shell.getRecognitionSettings().then((result: any) => {
      if (!live) return
      if (result.ok) hydrate(result.value)
      else setNotice('语音识别设置暂时无法读取。')
    }).catch(() => { if (live) setNotice('语音识别设置暂时无法读取。') })
    return () => { live = false }
  }, [shell])

  async function save (clearCredential = false): Promise<void> {
    const request: any = { expectedRevision: saved.revision, strategy, appKey: appKey.trim(),
      modelLabel: modelLabel.trim(), cloudDisclosureAccepted: disclosure }
    if (clearCredential) request.clearCredential = true
    else if (accessKeyId || accessKeySecret) request.credential = { accessKeyId: accessKeyId.trim(), accessKeySecret: accessKeySecret.trim() }
    setAccessKeyId(''); setAccessKeySecret(''); setBusy(true); setNotice('')
    try {
      const result = await shell.updateRecognitionSettings(request)
      if (result.ok) { hydrate(result.value); setNotice('识别设置已保存。') }
      else setNotice(`${ERRORS[result.code] || '设置未保存，请重试。'}${request.credential ? '凭据输入已清空，请重新输入后保存。' : ''}`)
    } catch { setNotice(`设置未保存，请重试。${request.credential ? '凭据输入已清空，请重新输入后保存。' : ''}`) } finally { delete request.credential; setBusy(false) }
  }
  async function verify (): Promise<void> {
    setBusy(true); setNotice('')
    try {
      const result = await shell.verifyRecognitionCredentials()
      setNotice(result.ok ? '已获取访问 Token；还未验证 AppKey、项目模型和识别效果。' : (ERRORS[result.code] || '凭据验证未成功，请检查网络与权限。'))
    } catch { setNotice('凭据验证未成功，请重试。') } finally { setBusy(false) }
  }
  const disabled = active || busy || !saved
  return <div className="recognition-settings">
    {saved?.loadError && <p role="alert">{saved.loadError === 'NLS_CREDENTIAL_CLEANUP_REQUIRED'
      ? ERRORS.NLS_CREDENTIAL_CLEANUP_REQUIRED
      : '识别设置损坏，暂时无法开始。请选择本地识别，或重新填写云端设置并保存。原设置文件仍会保留，但不再用于识别。'}</p>}
    <div className="group"><div className="row"><label className="label" htmlFor="recognitionStrategy">识别方式</label>
      <select id="recognitionStrategy" value={strategy} disabled={disabled} onChange={event => setStrategy(event.target.value)}>
        <option value="local-only">本地识别</option><option value="cloud-primary">云端识别（断连后转为本地）</option>
      </select></div>
      <p className="hint">选择云端识别时，本次会话不使用精修，即使断连后转为本地也一样。精修开关不变；请先停止会话再修改识别设置。</p></div>
    <div className="group">
      <p className="label">阿里云 NLS · 上海</p>
      <div className="row"><label htmlFor="nlsAppKey">项目 AppKey</label><input id="nlsAppKey" value={appKey} maxLength={256} disabled={disabled} onChange={event => setAppKey(event.target.value)} /></div>
      <div className="row"><label htmlFor="nlsModelLabel">项目模型备注</label><input id="nlsModelLabel" value={modelLabel} maxLength={160} disabled={disabled} onChange={event => setModelLabel(event.target.value)} /></div>
      <p className="hint">请在阿里云控制台选择 16 kHz 项目模型。这里的备注不会修改或锁定阿里云的模型设置。</p>
      <div className="row"><label htmlFor="nlsAccessKeyId">AccessKey ID</label><input id="nlsAccessKeyId" type="password" autoComplete="off" value={accessKeyId} maxLength={256} disabled={disabled} onChange={event => setAccessKeyId(event.target.value)} /></div>
      <div className="row"><label htmlFor="nlsAccessKeySecret">AccessKey Secret</label><input id="nlsAccessKeySecret" type="password" autoComplete="new-password" value={accessKeySecret} maxLength={1024} disabled={disabled} onChange={event => setAccessKeySecret(event.target.value)} /></div>
      <p className="hint" aria-live="polite">{saved?.credential?.present ? (saved.credential.scope === 'session_only' ? 'AccessKey 仅在本次运行中保留，退出后需重新输入。' : '凭据已加密保存；保留空白表示不更换。') : '尚未设置凭据。请使用自己的受限 RAM 凭据。'}</p>
      <label className="row"><input type="checkbox" checked={disclosure} disabled={disabled} onChange={event => setDisclosure(event.target.checked)} /><span>我确认：选择云端识别后，所选麦克风音频或系统音频将发送至阿里云上海。Speech-Agent 不保存音频；供应商处理和留存以其服务政策为准。</span></label>
      <p className="hint">云端断连后会尝试改用本地识别，切换前后的字幕可能漏字或重复。待处理音频过多时会停止采集，请按提示重试。</p>
      <div className="resource-actions"><button className="primary-btn" disabled={disabled} onClick={() => void save()}>保存识别设置</button>
        <button className="secondary-btn" disabled={disabled || !saved?.credential?.present} onClick={() => void verify()}>验证已保存凭据</button>
        <button className="secondary-btn" disabled={disabled || !saved?.credential?.present} onClick={() => void save(true)}>清除凭据</button></div>
    </div>
    <p className="note" role="status">{notice}</p>
  </div>
}
