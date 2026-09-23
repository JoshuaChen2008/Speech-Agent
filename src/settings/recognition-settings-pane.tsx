import { useEffect, useState, type ReactElement } from 'react'

const ERRORS: Record<string, string> = {
  NLS_SESSION_ACTIVE: '请先停止当前字幕会话。',
  NLS_SETTINGS_CONFLICT: '设置已变化，请重新打开本页后保存。',
  NLS_DISCLOSURE_REQUIRED: '请填写 AppKey 并确认音频上传说明。',
  NLS_AUTH_FAILED: '凭据验证失败，请检查 RAM AccessKey 和权限。',
  NLS_CLOCK_INVALID: '系统时间与签名时间不一致，请校正系统时间。',
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
      setNotice(result.ok ? 'Token 获取成功；尚未验证 AppKey、项目模型或识别效果。' : (ERRORS[result.code] || '凭据验证未成功，请检查网络与权限。'))
    } catch { setNotice('凭据验证未成功，请重试。') } finally { setBusy(false) }
  }
  const disabled = active || busy || !saved
  return <div className="recognition-settings">
    {saved?.loadError && <p role="alert">{saved.loadError === 'NLS_CREDENTIAL_CLEANUP_REQUIRED'
      ? ERRORS.NLS_CREDENTIAL_CLEANUP_REQUIRED
      : '识别配置无法恢复，尚未选择新的识别策略。请明确选择纯本地或重新填写云端配置并保存后再开始；原损坏文件及其中加密凭据会保留，不再用于识别。'}</p>}
    <div className="group"><div className="row"><label className="label" htmlFor="recognitionStrategy">权威识别策略</label>
      <select id="recognitionStrategy" value={strategy} disabled={disabled} onChange={event => setStrategy(event.target.value)}>
        <option value="local-only">纯本地权威识别</option><option value="cloud-primary">云端主力识别与本地降级</option>
      </select></div>
      <p className="hint">云端会话及其本地降级不启用精修，不改变全局精修偏好。活动会话中不能修改识别配置。</p></div>
    <div className="group">
      <p className="label">阿里云 NLS · 上海</p>
      <div className="row"><label htmlFor="nlsAppKey">项目 AppKey</label><input id="nlsAppKey" value={appKey} maxLength={256} disabled={disabled} onChange={event => setAppKey(event.target.value)} /></div>
      <div className="row"><label htmlFor="nlsModelLabel">项目模型说明（用户填写）</label><input id="nlsModelLabel" value={modelLabel} maxLength={160} disabled={disabled} onChange={event => setModelLabel(event.target.value)} /></div>
      <p className="hint">请在阿里云控制台选择 16 kHz 项目模型。此说明不证明云端模型版本不可变。</p>
      <div className="row"><label htmlFor="nlsAccessKeyId">AccessKey ID</label><input id="nlsAccessKeyId" type="password" autoComplete="off" value={accessKeyId} maxLength={256} disabled={disabled} onChange={event => setAccessKeyId(event.target.value)} /></div>
      <div className="row"><label htmlFor="nlsAccessKeySecret">AccessKey Secret</label><input id="nlsAccessKeySecret" type="password" autoComplete="new-password" value={accessKeySecret} maxLength={1024} disabled={disabled} onChange={event => setAccessKeySecret(event.target.value)} /></div>
      <p className="hint" aria-live="polite">{saved?.credential?.present ? (saved.credential.scope === 'session_only' ? '凭据仅本次应用进程使用，退出后需重新输入。' : '凭据已加密保存；保留空白表示不更换。') : '尚未设置凭据。请使用自己的受限 RAM 凭据。'}</p>
      <label className="row"><input type="checkbox" checked={disclosure} disabled={disabled} onChange={event => setDisclosure(event.target.checked)} /><span>我确认：选择云端策略后，所选麦克风音频或系统音频将发送至阿里云上海。应用不保存现场音频；供应商处理和留存以其服务政策为准。</span></label>
      <p className="hint">运行中断连将按供应商时间戳改由本地继续，切点附近可能漏字或重复；缓冲超限会停止采集并等待重试。</p>
      <div className="resource-actions"><button className="primary-btn" disabled={disabled} onClick={() => void save()}>保存识别设置</button>
        <button className="secondary-btn" disabled={disabled || !saved?.credential?.present} onClick={() => void verify()}>验证已保存凭据</button>
        <button className="secondary-btn" disabled={disabled || !saved?.credential?.present} onClick={() => void save(true)}>清除凭据</button></div>
    </div>
    <p className="note" role="status">{notice}</p>
  </div>
}
