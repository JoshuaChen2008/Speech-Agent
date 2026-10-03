import { useState, type ReactElement } from 'react'

type Dict = Record<string, any>

const CONTRACT_HEADER = Object.freeze({
  contract_id: 'speech-agent.agent-settings.ui',
  contract_version: '1.0.0'
})
const SUMMARY_CONTRACT_HEADER = Object.freeze({
  contract_id: 'speech-agent.session-summary-settings.ui',
  contract_version: '1.0.0'
})

function settingErrorMessage (code: unknown): string {
  switch (code) {
    case 'AGENT_SETTINGS_REVISION_CONFLICT': return '设置已在别处更新，请重新载入后再试。'
    case 'AGENT_SETTINGS_INVALID': return '设置请求无效，请检查后重试。'
    case 'AGENT_SETTINGS_PERMISSION_DENIED': return '当前窗口没有修改 助手设置的权限。'
    case 'AGENT_SETTINGS_UNAVAILABLE': return '助手设置暂时不可用，请稍后重试。'
    default: return '助手设置未能保存，请稍后重试。'
  }
}

export function AgentSettingsPane ({ shell, config, onConfigRefresh }: {
  shell: Dict, config: Dict | null, onConfigRefresh: () => Promise<void>
}): ReactElement {
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')

  const update = async (patch: Dict) => {
    if (!config || pending) return
    setPending(true)
    setNotice('正在保存 助手设置…')
    try {
      const response = await shell.setAgentSettings({
        ...CONTRACT_HEADER,
        expected_revision: config.agentSettingsRevision,
        agent_enabled: patch.agent_enabled ?? config.agentEnabled === true,
        memory_enabled: patch.memory_enabled ?? config.memoryEnabled !== false,
        cloud_disclosure_accepted: patch.cloud_disclosure_accepted ?? config.cloudDisclosureAccepted === true
      })
      if (response?.ok !== true) {
        setNotice(settingErrorMessage(response?.error?.code))
        await onConfigRefresh()
        return
      }
      setNotice('')
      await onConfigRefresh()
    } catch {
      setNotice('助手设置未能保存，请稍后重试。')
      await onConfigRefresh()
    } finally {
      setPending(false)
    }
  }

  const updateSummaryMemory = async (enabled: boolean) => {
    if (!config || pending || typeof shell.setSummaryMemoryPreference !== 'function') return
    setPending(true)
    setNotice('正在保存会话总结设置…')
    try {
      const response = await shell.setSummaryMemoryPreference({
        ...SUMMARY_CONTRACT_HEADER,
        expected_revision: config.agentSettingsRevision,
        summary_use_memory: enabled === true
      })
      if (response?.ok !== true) {
        setNotice(response?.error?.code === 'SESSION_SUMMARY_SETTINGS_REVISION_CONFLICT'
          ? '设置已在别处更新，请重新载入后再试。'
          : '会话总结设置未能保存，请稍后重试。')
        await onConfigRefresh()
        return
      }
      setNotice('')
      await onConfigRefresh()
    } catch {
      setNotice('会话总结设置未能保存，请稍后重试。')
      await onConfigRefresh()
    } finally {
      setPending(false)
    }
  }

  const agentEnabled = config?.agentEnabled === true
  const memoryEnabled = config?.memoryEnabled !== false
  const cloudDisclosureAccepted = config?.cloudDisclosureAccepted === true
  const summaryUseMemory = config?.summaryUseMemory !== false

  return <section className="agent-settings" aria-labelledby="agentSettingsTitle">
    <h2 id="agentSettingsTitle">AI 助手</h2>
    <p className="sub">使用模型生成总结、回答问题和整理记忆。关闭助手仍可使用字幕。</p>
    {notice !== '' && <p className="settings-status" role="status" aria-live="polite">{notice}</p>}
    <div className="group" aria-label="AI 助手设置">
      <div className="row">
        <div><div className="label">启用 AI 助手</div>
          <div className="hint">开启后可以生成总结、提问，并按设置整理记忆。</div></div>
        <label className="switch"><input type="checkbox" checked={agentEnabled} disabled={config == null || pending}
          aria-label="启用 AI 助手" onChange={(event) => void update({ agent_enabled: event.currentTarget.checked })} /><span>{agentEnabled ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">总结时参考记忆</div>
          <div className="hint">开启后，总结会参考相关记忆；关闭后，总结只依据本次会话，自动整理记忆不受影响。</div></div>
        <label className="switch"><input type="checkbox" checked={summaryUseMemory} disabled={config == null || pending || typeof shell.setSummaryMemoryPreference !== 'function'}
          aria-label="总结时参考记忆" onChange={(event) => void updateSummaryMemory(event.currentTarget.checked)} /><span>{summaryUseMemory ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">个人记忆</div>
          <div className="hint">需要先开启 AI 助手。关闭个人记忆后，不再自动添加或引用记忆，已有内容保留。</div></div>
        <label className="switch"><input type="checkbox" checked={memoryEnabled} disabled={config == null || pending}
          aria-label="启用个人记忆" onChange={(event) => void update({ memory_enabled: event.currentTarget.checked })} /><span>{memoryEnabled ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">允许发送到云端模型</div>
          <div className="hint">云端数据使用说明：使用云端模型生成回答、总结或整理记忆时，会按任务和记忆设置，将问题、相关字幕和记忆发送到你配置的模型服务商。数据如何处理和保留，以该服务商的政策为准。</div></div>
        <label className="switch"><input type="checkbox" checked={cloudDisclosureAccepted} disabled={config == null || pending}
          aria-label="允许发送到云端模型" onChange={(event) => void update({ cloud_disclosure_accepted: event.currentTarget.checked })} /><span>{cloudDisclosureAccepted ? '已允许' : '未允许'}</span></label>
      </div>
    </div>
    <p className="note">设置对之后的助手任务生效，不影响字幕识别、保存和导出。</p>
  </section>
}
