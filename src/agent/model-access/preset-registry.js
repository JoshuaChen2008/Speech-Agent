'use strict'

const { canonicalizeConnection } = require('./connection')

// These entries are application defaults. They are deliberately versioned and
// immutable: changing a request strategy requires a new preset identity.
const PRESETS = [
  {
    presetId: 'deepseek-openai', version: 1, providerLabel: 'DeepSeek', region: 'unspecified',
    modelId: 'deepseek-v4-flash', httpsOrigin: 'https://api.deepseek.com', basePath: '/',
    sourceSnapshotDate: '2026-08-30', helpId: 'deepseek-api-key', strategy: 'deepseek-openai@1', strategyVersion: 1,
    capabilities: { maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }
  },
  {
    presetId: 'openai-gpt-4.1-mini', version: 1, providerLabel: 'OpenAI', region: 'unspecified',
    modelId: 'gpt-4.1-mini-2025-04-14', httpsOrigin: 'https://api.openai.com', basePath: '/v1',
    sourceSnapshotDate: '2026-09-13', helpId: 'openai-api-key', strategy: 'openai-compatible@1', strategyVersion: 1,
    capabilities: { maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }
  },
  {
    presetId: 'qwen-beijing', version: 1, providerLabel: '通义千问', region: 'cn-beijing',
    modelId: 'qwen-plus', httpsOrigin: 'https://dashscope.aliyuncs.com', basePath: '/compatible-mode/v1',
    sourceSnapshotDate: '2026-09-13', helpId: 'qwen-beijing-api-key', strategy: 'qwen-beijing@1', strategyVersion: 1,
    capabilities: { maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }
  }
].map((entry) => Object.freeze({
  ...entry,
  capabilities: Object.freeze({ ...entry.capabilities }),
  identity: `${entry.presetId}@${entry.version}`
}))

if (new Set(PRESETS.map((entry) => entry.identity)).size !== PRESETS.length) throw new Error('model preset identities must be unique')

const MODEL_PRESETS = Object.freeze(PRESETS)
const HELP_URLS = Object.freeze({
  'deepseek-api-key': 'https://platform.deepseek.com/api_keys',
  'openai-api-key': 'https://platform.openai.com/api-keys',
  'qwen-beijing-api-key': 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'
})
const DEFAULT_REQUEST_STRATEGY = 'openai-compatible@1'
const REQUEST_STRATEGIES = Object.freeze(['openai-compatible@1', 'deepseek-openai@1', 'qwen-beijing@1'])

function publicPreset (entry) {
  return Object.freeze({
    presetId: entry.presetId,
    version: entry.version,
    providerLabel: entry.providerLabel,
    region: entry.region,
    modelId: entry.modelId,
    httpsOrigin: entry.httpsOrigin,
    basePath: entry.basePath,
    sourceSnapshotDate: entry.sourceSnapshotDate,
    helpId: entry.helpId,
    strategyVersion: entry.strategyVersion,
    capabilities: entry.capabilities
  })
}

function publicPresetCatalog () { return Object.freeze(MODEL_PRESETS.map(publicPreset)) }

function presetForIdentity (identity) {
  return MODEL_PRESETS.find((entry) => entry.identity === identity) || null
}

// Preset profiles use a reserved, generated id so a user-created profile whose
// id merely resembles a provider name can never inherit a vendor strategy.
function profileIdForPreset (presetId) {
  if (typeof presetId !== 'string' || !MODEL_PRESETS.some((entry) => entry.presetId === presetId)) return null
  return `preset.${presetId}`
}

function presetForProfileId (profileId) {
  if (typeof profileId !== 'string') return null
  return MODEL_PRESETS.find((entry) => profileIdForPreset(entry.presetId) === profileId) || null
}

function presetSource (input = {}) {
  if (typeof input.profileId === 'string') return presetForProfileId(input.profileId)
  if (typeof input.presetId === 'string') {
    const version = Number.isSafeInteger(input.version) ? input.version : 1
    return presetForIdentity(`${input.presetId}@${version}`)
  }
  return null
}

function strategyForModel (input = {}) {
  const source = presetSource(input)
  if (!source) return DEFAULT_REQUEST_STRATEGY
  let connection
  try { connection = canonicalizeConnection(input.httpsOrigin, input.basePath) } catch { return DEFAULT_REQUEST_STRATEGY }
  const match = source.httpsOrigin === connection.httpsOrigin &&
    source.basePath === connection.basePath && source.modelId === input.modelId
  return match ? source.strategy : DEFAULT_REQUEST_STRATEGY
}

function presetForModel (input = {}) {
  const source = presetSource(input)
  if (!source) return null
  let connection
  try { connection = canonicalizeConnection(input.httpsOrigin, input.basePath) } catch { return null }
  return source.httpsOrigin === connection.httpsOrigin &&
    source.basePath === connection.basePath && source.modelId === input.modelId ? source : null
}

module.exports = Object.freeze({
  HELP_URLS,
  MODEL_PRESETS,
  DEFAULT_REQUEST_STRATEGY,
  REQUEST_STRATEGIES,
  profileIdForPreset,
  presetForProfileId,
  presetForIdentity,
  presetForModel,
  publicPresetCatalog,
  strategyForModel
})
