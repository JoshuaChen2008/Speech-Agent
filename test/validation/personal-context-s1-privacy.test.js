'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { assertFixturePrivacy } = require('../../src/agent/contracts/agent-context-ui')
const { DIAGNOSTIC } = require('../../src/agent/execution-host')
const { unavailableManage, unavailableOverview } = require('../../src/main/ipc/personal-context-ipc')

test('SEM-F14/SEM-F30/J21: S1 public projections and diagnostics contain no text, audio, path, device, credential or scheduler internals', () => {
  assert.deepEqual(DIAGNOSTIC, { code: 'AGENT_SCHEDULER_FAILED' })
  for (const response of [unavailableOverview(), unavailableManage()]) {
    const serialized = JSON.stringify(response)
    assert.doesNotMatch(serialized, /caption_text|transcript_text|pcm|wav|device|credential|authorization|[A-Z]:\\|stack|wake_epoch|claim|lease|timer|generation/i)
  }
  for (const key of [
    'caption_text', 'transcript_text', 'pcm', 'wav', 'device_name', 'credential',
    'local_path', 'raw_error', 'stack', 'scheduler', 'wake_epoch', 'claim', 'lease'
  ]) {
    assert.throws(() => assertFixturePrivacy({ [key]: 'forbidden' }))
  }
})

test('SEM-F00/SEM-F30/J21: new product composition imports no retired Agent implementation tree', () => {
  const files = [
    'src/agent/personal-context/runtime.js',
    'src/agent/execution-host/formal-agent-job-scheduler.js',
    'src/main/ipc/personal-context-ipc.js'
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.doesNotMatch(source, /require\([^)]*(?:agent-mvp|formal-agent-store|plugin-host|memory-reader)/i)
  }
})
