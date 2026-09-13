'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { publicPresetCatalog, MODEL_PRESETS, strategyForModel } = require('../../src/agent/model-access/preset-registry')
const contract = require('../../src/agent/contracts/agent-model-presets-ui')

test('SEM-F36/J25: preset registry exposes three immutable exact identities and strategies', () => {
  const header = { contractId: contract.CONTRACT_ID, contractVersion: contract.CONTRACT_VERSION }
  const response = contract.assertGetPresetsResponse({ ...header, presets: publicPresetCatalog() })
  assert.deepEqual(response.presets.map((entry) => `${entry.presetId}@${entry.version}`), [
    'deepseek-openai@1', 'openai-gpt-4.1-mini@1', 'qwen-beijing@1'
  ])
  assert.equal(strategyForModel({ presetId: MODEL_PRESETS[0].presetId, version: MODEL_PRESETS[0].version, httpsOrigin: MODEL_PRESETS[0].httpsOrigin, basePath: MODEL_PRESETS[0].basePath, modelId: MODEL_PRESETS[0].modelId }), 'deepseek-openai@1')
  assert.equal(strategyForModel({ presetId: MODEL_PRESETS[1].presetId, version: MODEL_PRESETS[1].version, httpsOrigin: MODEL_PRESETS[1].httpsOrigin, basePath: MODEL_PRESETS[1].basePath, modelId: MODEL_PRESETS[1].modelId }), 'openai-compatible@1')
  assert.equal(strategyForModel({ presetId: MODEL_PRESETS[2].presetId, version: MODEL_PRESETS[2].version, httpsOrigin: MODEL_PRESETS[2].httpsOrigin, basePath: MODEL_PRESETS[2].basePath, modelId: MODEL_PRESETS[2].modelId }), 'qwen-beijing@1')
  assert.deepEqual(response.presets.map((entry) => entry.strategyVersion), [1, 1, 1])
  assert.equal(Object.isFrozen(MODEL_PRESETS[0]), true)
  assert.equal(Object.isFrozen(MODEL_PRESETS[0].capabilities), true)
  assert.throws(() => contract.assertGetPresetsResponse({ ...header, presets: [{ ...response.presets[0], strategy: 'vendor' }] }), /invalid/i)
})
