'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { AgentCoreError } = require('../../src/agent-core/errors')
const { canonicalBytes } = require('../../src/agent-core/formal/contracts')
const { AgentInputPlanner, chunkEnvelope } = require('../../src/agent-core/formal/input-planner')
const { MeetingMinutesPlugin } = require('../../src/agent-core/formal/meeting-minutes-plugin')
const { AgentPluginHost } = require('../../src/agent-core/formal/plugin-host')

const INPUT_REF = Object.freeze({
  sessionId: 'formal-session',
  inputWatermark: 2,
  transcriptVersion: 'original',
  inputDigest: 'a'.repeat(64)
})

function item (eventOrder, text) {
  return {
    segmentId: `segment-${eventOrder}`,
    sourceId: 'loopback',
    eventOrder,
    t0Ms: (eventOrder - 1) * 1000,
    t1Ms: eventOrder * 1000,
    text
  }
}

function job (overrides = {}) {
  return {
    jobId: 'job-1',
    runId: 'run-1',
    taskKind: 'meeting-minutes',
    state: 'running',
    sessionId: INPUT_REF.sessionId,
    inputRef: INPUT_REF,
    recipeVersion: 'meeting-minutes@1',
    providerId: 'cloud-primary',
    providerKind: 'cloud',
    model: 'model-primary',
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAt: 0,
    lease: { owner: 'runner', expiresAt: 100000 },
    cancelRequestedAt: null,
    errorCode: null,
    requestedBy: 'automatic',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

test('SEM-F28 / J24-B27 plans exact UTF-8 boundaries and preserves Unicode code points', () => {
  const planner = new AgentInputPlanner()
  const snapshot = { inputRef: INPUT_REF, items: [item(1, 'alpha'), item(2, 'beta')] }
  const fullSegments = [
    { eventOrder: 1, t0Ms: 0, t1Ms: 1000, fromCodePoint: 0, throughCodePoint: 5, text: 'alpha' },
    { eventOrder: 2, t0Ms: 1000, t1Ms: 2000, fromCodePoint: 0, throughCodePoint: 4, text: 'beta' }
  ]
  const exactLimit = canonicalBytes(chunkEnvelope(INPUT_REF, fullSegments))
  const exact = planner.plan(snapshot, { maxChunkInputBytes: exactLimit, maxResultBytes: 1024 })
  assert.equal(exact.mode, 'single')
  assert.equal(exact.chunks.length, 1)

  const overByOne = planner.plan(snapshot, { maxChunkInputBytes: exactLimit - 1, maxResultBytes: 1024 })
  assert.equal(overByOne.mode, 'chunked')
  assert.deepEqual(overByOne.chunks.map((chunk) => chunk.segments.length), [1, 1])

  const emoji = '😀边界'.repeat(120)
  const long = planner.plan(
    { inputRef: { ...INPUT_REF, inputWatermark: 1 }, items: [item(1, emoji)] },
    { maxChunkInputBytes: 420, maxResultBytes: 1024 }
  )
  assert.equal(long.chunks.length > 1, true)
  const parts = long.chunks.flatMap((chunk) => chunk.segments)
  assert.equal(parts.map((part) => part.text).join(''), emoji)
  assert.equal(parts.every((part) => Array.from(part.text).join('') === part.text), true)
  assert.equal(parts[0].fromCodePoint, 0)
  assert.equal(parts.at(-1).throughCodePoint, Array.from(emoji).length)
})

test('SEM-F15/SEM-F16 / J13/J24-B20 rejects invented owner identity and hides source routing from model input', async () => {
  const snapshot = { inputRef: INPUT_REF, items: [item(1, 'synthetic action without speaker identity'), item(2, 'synthetic due date')] }
  const modelCalls = []
  const host = new AgentPluginHost({
    transcriptReader: { readSnapshot: async () => snapshot },
    inputPlanner: new AgentInputPlanner(),
    modelGateway: {
      getLimits: async () => ({ maxChunkInputBytes: 4096, maxResultBytes: 4096 }),
      execute: async (request) => {
        modelCalls.push(request)
        return {
          type: 'meeting-minutes',
          content: {
            overview: 'overview',
            conclusions: [],
            actionItems: [{
              text: 'follow up', owner: 'invented owner', due: null,
              evidence: [{ fromEventOrder: 1, throughEventOrder: 1 }]
            }],
            risks: []
          }
        }
      }
    }
  })
  await assert.rejects(host.executeJob(job()), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  assert.equal(modelCalls.length, 1)
  assert.equal(Object.hasOwn(modelCalls[0].input.segments[0], 'sourceId'), false)
  assert.equal(Object.hasOwn(modelCalls[0].input.segments[0], 'segmentId'), false)
})

test('SEM-F16 / J24-B19 exposes only loaded tasks and bounds an uncooperative plugin timeout', async () => {
  let observedSignal = null
  const host = new AgentPluginHost({
    transcriptReader: { readSnapshot: async () => ({ inputRef: INPUT_REF, items: [item(1, 'timeout input'), item(2, 'second')] }) },
    inputPlanner: new AgentInputPlanner(),
    modelGateway: {
      getLimits: async () => ({ maxChunkInputBytes: 4096, maxResultBytes: 4096 }),
      execute: async (request, signal) => {
        observedSignal = signal
        return new Promise(() => {})
      }
    },
    timeoutMs: 20
  })
  assert.deepEqual(host.availableTaskKinds(), ['meeting-minutes'])
  await assert.rejects(host.executeJob(job()), (error) => error.code === 'AGENT_INTERNAL_FAILURE')
  assert.equal(observedSignal.aborted, true)
  host.unload('meeting-minutes')
  assert.deepEqual(host.availableTaskKinds(), [])
  assert.throws(
    () => host.assertPermission(host.getRecipe('meeting-minutes@1'), 'filesystem.write'),
    (error) => error instanceof AgentCoreError && error.code === 'AGENT_PERMISSION_DENIED'
  )
})

test('SEM-F16 / J24-B19 aborts an active job when one of its plugins is unloaded', async () => {
  let releaseProvider
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const host = new AgentPluginHost({
    transcriptReader: { readSnapshot: async () => ({ inputRef: INPUT_REF, items: [item(1, 'unload input'), item(2, 'second')] }) },
    inputPlanner: new AgentInputPlanner(),
    modelGateway: {
      getLimits: async () => ({ maxChunkInputBytes: 4096, maxResultBytes: 4096 }),
      execute: async () => {
        providerStarted()
        return new Promise((resolve) => { releaseProvider = resolve })
      }
    }
  })
  const running = host.executeJob(job())
  await started
  host.unload('meeting-minutes')
  releaseProvider({
    type: 'meeting-minutes',
    content: { overview: 'late output', conclusions: [], actionItems: [], risks: [] }
  })
  await assert.rejects(running, (error) => error.code === 'AGENT_PLUGIN_INVALID')
  assert.deepEqual(host.availableTaskKinds(), [])
})

test('SEM-F28 / J24-B27 rejects an impossible merge budget before the first provider call', async () => {
  const plugin = new MeetingMinutesPlugin()
  let providerCalls = 0
  await assert.rejects(plugin.generate({
    job: job(),
    plan: {
      inputRef: INPUT_REF,
      chunks: [
        { chunkIndex: 0, chunkCount: 2, segments: [{ eventOrder: 1, t0Ms: 0, t1Ms: 1, fromCodePoint: 0, throughCodePoint: 1, text: 'a' }] },
        { chunkIndex: 1, chunkCount: 2, segments: [{ eventOrder: 2, t0Ms: 1, t1Ms: 2, fromCodePoint: 0, throughCodePoint: 1, text: 'b' }] }
      ]
    },
    limits: { maxChunkInputBytes: 256, maxResultBytes: 128 },
    invokeModel: async () => {
      providerCalls += 1
      throw new Error('provider must not be called')
    }
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(providerCalls, 0)
})
