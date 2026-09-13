// @ts-check
// 纯逻辑 view-model：把 agent-model-ui@1.0.0 契约的 snapshot 转成产品文案与表单派生值。
// 不碰 DOM、不发起 IPC；renderer 与测试都通过这里得到同一份推导规则。

export type ModelPurpose = 'default' | 'information_extraction' | 'summary' | 'analysis_planning'
export type AssignmentMode = 'direct' | 'fallback_default' | 'unconfigured'
export type Readiness = 'ready' | 'provider_not_configured' | 'credential_unavailable'
export type CredentialScope = 'absent' | 'persistent' | 'session_only'
export type RemoteStatus =
  | 'success' | 'revision_conflict' | 'invalid_request'
  | 'credential_unavailable' | 'redirect_rejected' | 'remote_unavailable'
export type ModelTestStatus =
  | 'success' | 'invalid_request' | 'revision_conflict' | 'credential_unavailable'
  | 'auth_failed' | 'timeout' | 'rate_limited' | 'redirect_rejected'
  | 'response_invalid' | 'remote_unavailable' | 'cancelled'

export const MODEL_PURPOSES: readonly ModelPurpose[] = [
  'default', 'information_extraction', 'summary', 'analysis_planning'
]

export const PURPOSE_LABELS: Record<ModelPurpose, string> = {
  default: '默认',
  information_extraction: '信息提取',
  summary: '摘要与总结',
  analysis_planning: '分析与规划'
}

export const ASSIGNMENT_LABELS: Record<AssignmentMode, string> = {
  direct: '已单独配置',
  fallback_default: '回落到默认',
  unconfigured: '未配置'
}

export const READINESS_LABELS: Record<Readiness, string> = {
  ready: '配置充分',
  provider_not_configured: '未配置可用的模型',
  credential_unavailable: '缺少可用的 API 密钥'
}

export const CREDENTIAL_LABELS: Record<CredentialScope, string> = {
  absent: '未设置 API 密钥',
  persistent: '已设置 API 密钥（保存在本机）',
  session_only: '已设置 API 密钥（仅本次运行有效，重启后需重新设置）'
}

export const REMOTE_STATUS_LABELS: Record<RemoteStatus, string> = {
  success: '已获取模型建议',
  revision_conflict: '配置已在别处更新，请重新载入后再试',
  invalid_request: '请求无效，未获取建议',
  credential_unavailable: '缺少 API 密钥，无法获取建议',
  redirect_rejected: '服务器返回了不受信任的跳转，已拒绝',
  remote_unavailable: '暂时无法连接服务器'
}

export const MODEL_TEST_STATUS_LABELS: Record<ModelTestStatus, string> = {
  success: '模型测试成功：本次协议响应有效',
  invalid_request: '模型测试请求无效，请检查连接与模型名称',
  revision_conflict: '配置已更新，请重新载入后再测试',
  credential_unavailable: '未设置可用的 API 密钥',
  auth_failed: 'API 密钥未被服务接受，请检查密钥后重试',
  timeout: '服务响应超时，可以稍后重试',
  rate_limited: '服务暂时限流，可以稍后重试',
  redirect_rejected: '服务器跳转未被信任，已拒绝本次测试',
  response_invalid: '服务返回格式无法识别，请检查模型名称或能力设置',
  remote_unavailable: '暂时无法连接服务，可以稍后重试',
  cancelled: '模型测试已取消'
}

export const MODEL_TEST_NEXT_ACTION_LABELS = {
  none: '', reload: '重新载入配置', set_credential: '设置 API 密钥',
  edit_connection: '检查连接与模型名称', check_model: '检查模型能力', retry: '重试测试'
} as const

export interface ModelPreset {
  presetId: string
  version: number
  providerLabel: string
  region: 'unspecified' | 'cn-beijing'
  modelId: string
  httpsOrigin: string
  basePath: string
  sourceSnapshotDate: string
  helpId: string
  strategyVersion: number
  capabilities: CapabilitiesV1
}

export interface CapabilitiesV1 {
  maxInputTokens: number
  maxOutputTokens: number
  supportsToolCalling: boolean
  supportsStructuredOutput: boolean
  supportsStreaming: boolean
  usageReporting: boolean
}

export interface ModelEntry { modelId: string, capabilities: CapabilitiesV1 }

export interface CredentialState { present: boolean, scope: CredentialScope }

export interface TemplateSuggestion {
  templateVersion: 1
  source: 'official_docs'
  sourceSnapshotDate: string
  modelId: string
  capabilitySuggestion: Partial<CapabilitiesV1> & Record<string, unknown>
}

export interface ProfileEntry {
  profileId: string
  label: string
  profileRevision: number
  catalogRevision: number
  httpsOrigin: string
  basePath: string
  templateId: string | null
  templateSuggestion: TemplateSuggestion | null
  models: ModelEntry[]
  credential: CredentialState
}

export interface ReadinessEntry {
  assignmentMode: AssignmentMode
  providerKind: 'local' | 'cloud' | null
  target: { profileId: string, modelId: string } | null
  singleShot: Readiness
  agentLoop: Readiness
}

export interface CatalogSnapshot {
  revision: number
  profiles: ProfileEntry[]
  readinessByPurpose: Record<ModelPurpose, ReadinessEntry>
}

/** 只保留小写字母、数字与 `. _ : -`，首字符必须是字母或数字；推导不出合法值时返回空串。 */
export function deriveProfileId (label: string): string {
  const collapsed = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-')
  if (collapsed.length === 0) return ''
  if (!/^[a-z0-9]/.test(collapsed)) return ''
  return collapsed.slice(0, 128)
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/

export function isValidProfileId (value: string): boolean {
  return PROFILE_ID_PATTERN.test(value)
}

export interface ModelTarget { profileId: string, profileLabel: string, modelId: string }

/** 把所有档案下的 model 摊平成 (profileId, modelId) 选项，用于用途分配下拉。 */
export function modelTargets (snapshot: CatalogSnapshot): ModelTarget[] {
  const targets: ModelTarget[] = []
  for (const profile of snapshot.profiles) {
    for (const model of profile.models) {
      targets.push({ profileId: profile.profileId, profileLabel: profile.label, modelId: model.modelId })
    }
  }
  return targets
}

export interface CapabilityForm {
  maxInputTokens: string
  maxOutputTokens: string
  supportsToolCalling: boolean | null
  supportsStructuredOutput: boolean | null
  supportsStreaming: boolean | null
  usageReporting: boolean | null
}

export function emptyCapabilityForm (): CapabilityForm {
  return {
    maxInputTokens: '', maxOutputTokens: '',
    supportsToolCalling: null, supportsStructuredOutput: null, supportsStreaming: null, usageReporting: null
  }
}

/** 六字段全部作答才返回 capabilities；前端不猜测、不探测、不补默认值。 */
export function capabilityFormToCapabilities (form: CapabilityForm): CapabilitiesV1 | null {
  const maxInputTokens = Number(form.maxInputTokens)
  const maxOutputTokens = Number(form.maxOutputTokens)
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) return null
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return null
  if (form.supportsToolCalling === null || form.supportsStructuredOutput === null ||
      form.supportsStreaming === null || form.usageReporting === null) return null
  return {
    maxInputTokens, maxOutputTokens,
    supportsToolCalling: form.supportsToolCalling,
    supportsStructuredOutput: form.supportsStructuredOutput,
    supportsStreaming: form.supportsStreaming,
    usageReporting: form.usageReporting
  }
}

export function capabilitySummary (capabilities: CapabilitiesV1): string {
  const bool = (value: boolean, label: string): string => `${label}：${value ? '支持' : '不支持'}`
  const usage = capabilities.usageReporting
    ? '用量上报：支持'
    : '用量上报：不支持（交互不会显示 token，也无法参与用量比较）'
  return [
    `输入上限 ${capabilities.maxInputTokens.toLocaleString('zh-CN')} token`,
    `输出上限 ${capabilities.maxOutputTokens.toLocaleString('zh-CN')} token`,
    bool(capabilities.supportsToolCalling, '工具调用'),
    bool(capabilities.supportsStructuredOutput, '结构化输出'),
    bool(capabilities.supportsStreaming, '流式输出'),
    usage
  ].join(' · ')
}

/** 只接受更高或相等的 revision；用于拒绝迟到的旧 snapshot/事件。 */
export function acceptsRevision (current: number | null, incoming: number): boolean {
  return current === null || incoming >= current
}

export function findProfile (snapshot: CatalogSnapshot, profileId: string): ProfileEntry | null {
  return snapshot.profiles.find((profile) => profile.profileId === profileId) ?? null
}

export function profileIdTaken (snapshot: CatalogSnapshot, profileId: string): boolean {
  return snapshot.profiles.some((profile) => profile.profileId === profileId)
}
