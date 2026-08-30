'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('SEM-F14/SEM-F33/J25: model-access fixtures stay preview-only, private, and outside evidence roots', () => {
  const root = path.join(process.cwd(), 'src', 'agent', 'contracts', 'fixtures', 'agent-model-ui', 'v1.0.0')
  const files = fs.readdirSync(root).filter((name) => name.endsWith('.json'))
  assert.equal(files.length >= 4, true)
  for (const name of files) {
    const value = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
    assert.equal(value.previewOnly, true)
    const serialized = JSON.stringify(value)
    assert.doesNotMatch(serialized, /authorization|apiKey|credentialSlot|rawError|stack|[A-Z]:\\|\.wav|captionText|transcriptText/i)
    assert.doesNotMatch(serialized, /"(?:price|cost|currency|pricing)[^"]*"/i)
  }
})

test('SEM-F33/J25: fauxProvider is test-only and absent from the production model-access export graph', () => {
  const production = require('../../src/agent/model-access')
  assert.deepEqual(Object.keys(production), ['createModelAccess'])
  assert.equal('fauxProvider' in production, false)
  assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'agent', 'model-access', 'faux-provider.js')), false)
})
