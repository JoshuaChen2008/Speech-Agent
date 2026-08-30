'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  assertCatalogResponse, assertChangedEvent, assertConfigureResponse, assertPullResponse
} = require('../../src/agent/contracts/agent-model-ui')
const { assertModelUsage } = require('../../src/agent/contracts/model-access-core')

test('SEM-F14/SEM-F33/J25: model-access fixtures stay preview-only, private, and outside evidence roots', () => {
  const root = path.join(process.cwd(), 'src', 'agent', 'contracts', 'fixtures', 'agent-model-ui', 'v1.0.0')
  const files = fs.readdirSync(root).filter((name) => name.endsWith('.json'))
  const scenarios = new Set()
  for (const name of files) {
    const document = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
    const fixtures = Array.isArray(document) ? document : [document]
    for (const value of fixtures) {
    assert.equal(value.previewOnly, true)
    assert.deepEqual(Object.keys(value).sort(), ['kind', 'payload', 'previewOnly', 'scenario'])
    for (const scenario of Array.isArray(value.scenario) ? value.scenario : [value.scenario]) scenarios.add(scenario)
    if (value.kind === 'catalogResponse') assertCatalogResponse(value.payload)
    else if (value.kind === 'configureResponse') assertConfigureResponse(value.payload)
    else if (value.kind === 'pullResponse') assertPullResponse(value.payload)
    else if (value.kind === 'changedEvent') assertChangedEvent(value.payload)
    else if (value.kind === 'modelUsage') assertModelUsage(value.payload)
    else assert.fail(`unknown fixture kind: ${value.kind}`)
    const serialized = JSON.stringify(value)
    assert.doesNotMatch(serialized, /authorization|apiKey|credentialSlot|rawError|stack|[A-Z]:\\|\.wav|captionText|transcriptText/i)
    assert.doesNotMatch(serialized, /"(?:price|cost|currency|pricing)[^"]*"/i)
    }
  }
  for (const scenario of [
    'deepseek-template-empty-models', 'template-deleted-not-reseeded', 'user-confirmed-capabilities',
    'credential-persistent', 'credential-session-only', 'credential-restart-absent',
    'purpose-direct', 'purpose-fallback-default', 'purpose-unconfigured',
    'configure-success', 'configure-invalid', 'configure-revision-conflict', 'changed-reload',
    'remote-success', 'remote-revision-conflict', 'remote-invalid-request',
    'remote-credential-unavailable', 'remote-redirect-rejected', 'remote-unavailable',
    'provider-cache-hit', 'provider-cache-unknown', 'estimated-cache-unknown', 'inconsistent-cache-unknown'
  ]) assert.equal(scenarios.has(scenario), true, `missing preview fixture: ${scenario}`)
})

test('SEM-F33/J25: fauxProvider is test-only and absent from the production model-access export graph', () => {
  const production = require('../../src/agent/model-access')
  const release = require('../../electron-builder.config.cjs')
  assert.deepEqual(Object.keys(production), ['createModelAccess'])
  assert.equal('fauxProvider' in production, false)
  assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'agent', 'model-access', 'faux-provider.js')), false)
  assert.equal(fs.existsSync(path.join(process.cwd(), 'test', 'integration', 'faux-provider.js')), true)
  assert.equal(release.files.includes('src/**/*'), true)
  assert.equal(release.files.some((entry) => /(?:^|\/)test(?:\/|$)/i.test(entry)), false)
  const sourceFiles = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.[cm]?js$/.test(entry.name)) sourceFiles.push(target)
    }
  }
  visit(path.join(process.cwd(), 'src', 'agent', 'model-access'))
  assert.equal(sourceFiles.some((file) => /faux-provider|registerAdapter/.test(fs.readFileSync(file, 'utf8'))), false)
})
