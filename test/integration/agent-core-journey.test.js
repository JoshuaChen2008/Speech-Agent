'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentMvpStore } = require('../../src/agent-core/storage/agent-store')
const { AgentPluginHost } = require('../../src/agent-core/plugin-host')
const { ModelGateway } = require('../../src/agent-core/model-gateway')
const { PiAgentAdapter } = require('../../src/agent-core/pi-agent-adapter')
const { AgentJobRunner } = require('../../src/agent-core/job-runner')

test('J23 Pi Agent Loop reads a real terminal snapshot and writes one structured artifact', async (t) => {
  const faux = await import('@earendil-works/pi-ai/providers/faux')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-j23-'))
  let now = 1000
  const store = new AgentMvpStore({ databasePath: path.join(root, 'agent.db'), now: () => now++ })
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const input = store.createFixtureSession({ captions: ['讨论发布节奏', '决定先验证隔离内核'] })
  const created = store.createUserJob({
    inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'confirm-reference-output'
  })
  const publicEvents = []
  const gateway = new ModelGateway({ testResponses: [
    faux.fauxAssistantMessage(faux.fauxToolCall('read_selected_transcript', {})),
    faux.fauxAssistantMessage(JSON.stringify({ title: '参考产物', bullets: ['已读取冻结输入'] }))
  ] })
  const runner = new AgentJobRunner({
    store, pluginHost: new AgentPluginHost(), modelGateway: gateway, adapter: new PiAgentAdapter(),
    onEvent: (event) => publicEvents.push(event)
  })
  const result = await runner.runNext()
  assert.equal(result.job.runId, created.job.runId)
  assert.equal(result.job.state, 'succeeded')
  assert.deepEqual(result.artifact.content, { title: '参考产物', bullets: ['已读取冻结输入'] })
  assert.equal(publicEvents.filter((event) => event.type === 'tool_execution_start').length, 1)
  assert.equal(JSON.stringify(publicEvents).includes('讨论发布节奏'), false)
  assert.equal(JSON.stringify(publicEvents).includes('thinking'), false)
})

test('J23 schema failure is terminal and does not write an artifact', async (t) => {
  const faux = await import('@earendil-works/pi-ai/providers/faux')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-j23-failure-'))
  const store = new AgentMvpStore({ databasePath: path.join(root, 'agent.db') })
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const input = store.createFixtureSession({ captions: ['fixture'] })
  const created = store.createUserJob({ inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'bad-schema' })
  const gateway = new ModelGateway({ testResponses: [
    faux.fauxAssistantMessage(faux.fauxToolCall('read_selected_transcript', {})),
    faux.fauxAssistantMessage('{"unexpected":true}')
  ] })
  const runner = new AgentJobRunner({ store, pluginHost: new AgentPluginHost(), modelGateway: gateway, adapter: new PiAgentAdapter() })
  const result = await runner.runNext()
  assert.equal(result.job.state, 'failed')
  assert.equal(result.job.errorCode, 'AGENT_OUTPUT_INVALID')
  assert.equal(store.getArtifact(created.job.runId), null)
})
