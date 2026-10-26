'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { retryPolicy, retryDelay, parseRetryAfter } = require('../../src/agent/contracts/retry-policy')

test('SEM-F28/F33/T15/J22/J24: only the execution host owns the locked Pi loop', () => {
  const root = path.resolve(__dirname, '../..')
  const manifest = require('../../package.json')
  const lock = require('../../package-lock.json')
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-telemetry']) {
    assert.equal(lock.packages[`node_modules/@earendil-works/${name}`].version, '0.84.1')
    assert.equal(lock.packages[`node_modules/@earendil-works/${name}`].license, 'MIT')
  }
  assert.equal(manifest.dependencies['@earendil-works/pi-agent-core'], '0.84.1')
  for (const file of fs.readdirSync(path.join(root, 'src/agent/model-access')).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, 'src/agent/model-access', file), 'utf8')
    assert.doesNotMatch(source, /execution-host|pi-agent-core|agentLoop\(|runWithBinding\(/u, file)
    if (['runtime.js', 'openai-compatible-adapter.js'].includes(file)) assert.doesNotMatch(source, /async run\s*\(/u, file)
  }
  const source = fs.readFileSync(path.join(root, 'src/agent/execution-host/pi-loop-runtime.js'), 'utf8')
  assert.match(source, /toolExecution: 'sequential'/u)
  assert.doesNotMatch(source, /agentLoopContinue|prepareNextTurn|getDefaultStreamFn|providers\/all|pi-coding-agent/u)
  const notice = fs.readFileSync(path.join(root, 'src/agent/execution-host/PI-NOTICE.md'), 'utf8')
  assert.match(notice, /Copyright \(c\) 2025 Mario Zechner/u)
})

test('SEM-F28/F40/J30-RECOVERY: retry policy keeps legacy delays and bounds new jitter', () => {
  assert.equal(retryPolicy(null), 'agent-retry@1')
  assert.equal(retryPolicy(), 'agent-retry@1')
  assert.throws(() => retryPolicy('unknown'), { code: 'AGENT_REQUEST_INVALID' })
  for (let attempt = 1; attempt <= 5; attempt++) {
    const base = Math.min(1000, 100 * 2 ** (attempt - 1))
    assert.equal(retryDelay('agent-retry@1', attempt, 0), base)
    assert.equal(retryDelay('agent-retry@2', attempt, null, () => 0), base / 2)
    assert.equal(retryDelay('agent-retry@2', attempt, null, () => 1), base)
  }
  assert.equal(retryDelay('agent-retry@2', 1, 5000), 5000)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter('0.05'), 50)
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000)
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 0)
  for (const invalid of ['-1', 'NaN', '999999999999999999999', 'private provider text', null]) assert.equal(parseRetryAfter(invalid), null)
})
