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
    case 'AGENT_SETTINGS_PERMISSION_DENIED': return '当前窗口没有修改 Agent 设置的权限。'
    case 'AGENT_SETTINGS_UNAVAILABLE': return 'Agent 设置暂时不可用，请稍后重试。'
    default: return 'Agent 设置未能保存，请稍后重试。'
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
    setNotice('正在保存 Agent 设置…')
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
      setNotice('Agent 设置未能保存，请稍后重试。')
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
    <h2 id="agentSettingsTitle">Agent 系统</h2>
    <p className="sub">Agent 系统是可选能力，字幕系统在它关闭或不可用时仍独立运行。</p>
    {notice !== '' && <p className="settings-status" role="status" aria-live="polite">{notice}</p>}
    <div className="group" aria-label="Agent 系统设置">
      <div className="row">
        <div><div className="label">启用 Agent 系统</div>
          <div className="hint">开启后才会创建后台 Agent 任务和正式 Agent 交互。</div></div>
        <label className="switch"><input type="checkbox" checked={agentEnabled} disabled={config == null || pending}
          aria-label="启用 Agent 系统" onChange={(event) => void update({ agent_enabled: event.currentTarget.checked })} /><span>{agentEnabled ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">总结时参考记忆</div>
          <div className="hint">生成总结时补充已记住的信息；关闭后仍可自动整理记忆，只使用本次会话。</div></div>
        <label className="switch"><input type="checkbox" checked={summaryUseMemory} disabled={config == null || pending || typeof shell.setSummaryMemoryPreference !== 'function'}
          aria-label="总结时参考记忆" onChange={(event) => void updateSummaryMemory(event.currentTarget.checked)} /><span>{summaryUseMemory ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">个人记忆</div>
          <div className="hint">只在 Agent 系统开启时生效；关闭后不会自动摄取新的个人上下文。</div></div>
        <label className="switch"><input type="checkbox" checked={memoryEnabled} disabled={config == null || pending}
          aria-label="启用个人记忆" onChange={(event) => void update({ memory_enabled: event.currentTarget.checked })} /><span>{memoryEnabled ? '已开启' : '已关闭'}</span></label>
      </div>
      <div className="row">
        <div><div className="label">云端模型披露</div>
          <div className="hint">允许使用已配置的云端 Agent 模型前，需要明确确认数据会发送到该服务。</div></div>
        <label className="switch"><input type="checkbox" checked={cloudDisclosureAccepted} disabled={config == null || pending}
          aria-label="确认云端模型披露" onChange={(event) => void update({ cloud_disclosure_accepted: event.currentTarget.checked })} /><span>{cloudDisclosureAccepted ? '已确认' : '未确认'}</span></label>
      </div>
    </div>
    <p className="note">这些开关只影响后续 Agent 处理周期；字幕采集、首次稳定转写、历史与导出保持原有生命周期。</p>
  </section>
}
