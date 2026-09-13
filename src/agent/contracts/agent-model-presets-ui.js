'use strict'

const CONTRACT_ID = 'agent-model-presets-ui'
const CONTRACT_VERSION = '1.0.0'
const IPC_CHANNELS = Object.freeze({ getPresets: 'agent-model:get-presets' })
const HELP_IDS = Object.freeze(['deepseek-api-key', 'openai-api-key', 'qwen-beijing-api-key'])
const REGIONS = Object.freeze(['unspecified', 'cn-beijing'])

function fail (path) { throw new TypeError(`${path}: invalid model preset UI contract`) }
function exact (value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(path)
}
function header (value, path) {
  if (value.contractId !== CONTRACT_ID || value.contractVersion !== CONTRACT_VERSION) fail(path)
}
function text (value, path, maximum = 2048) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(path)
}
function assertCapabilities (value, path) {
  exact(value, ['maxInputTokens', 'maxOutputTokens', 'supportsToolCalling', 'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'], path)
  for (const key of ['maxInputTokens', 'maxOutputTokens']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail(`${path}.${key}`)
  }
  for (const key of ['supportsToolCalling', 'supportsStructuredOutput', 'supportsStreaming', 'usageReporting']) {
    if (typeof value[key] !== 'boolean') fail(`${path}.${key}`)
  }
}
function assertPreset (value, path) {
  exact(value, ['presetId', 'version', 'providerLabel', 'region', 'modelId', 'httpsOrigin', 'basePath', 'sourceSnapshotDate', 'helpId', 'strategyVersion', 'capabilities'], path)
  text(value.presetId, `${path}.presetId`, 128); text(value.providerLabel, `${path}.providerLabel`, 128)
  text(value.modelId, `${path}.modelId`, 256); text(value.httpsOrigin, `${path}.httpsOrigin`); text(value.basePath, `${path}.basePath`, 1024)
  text(value.sourceSnapshotDate, `${path}.sourceSnapshotDate`, 32)
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !Number.isSafeInteger(value.strategyVersion) || value.strategyVersion < 1 || !REGIONS.includes(value.region) || !HELP_IDS.includes(value.helpId)) fail(path)
  assertCapabilities(value.capabilities, `${path}.capabilities`)
}
function assertGetPresetsRequest (value) {
  exact(value, ['contractId', 'contractVersion'], 'getPresetsRequest'); header(value, 'getPresetsRequest'); return value
}
function assertGetPresetsResponse (value) {
  exact(value, ['contractId', 'contractVersion', 'presets'], 'getPresetsResponse'); header(value, 'getPresetsResponse')
  if (!Array.isArray(value.presets) || new Set(value.presets.map((entry) => `${entry.presetId}@${entry.version}`)).size !== value.presets.length) fail('getPresetsResponse.presets')
  value.presets.forEach((entry, index) => assertPreset(entry, `getPresetsResponse.presets[${index}]`))
  return value
}

module.exports = Object.freeze({ CONTRACT_ID, CONTRACT_VERSION, IPC_CHANNELS, assertGetPresetsRequest, assertGetPresetsResponse })
