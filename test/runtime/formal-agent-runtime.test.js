'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { AgentCoreError } = require('../../src/agent-core/errors')
const { mergeInput } = require('../../src/agent-core/formal/bounded-merge')
const { canonicalBytes } = require('../../src/agent-core/formal/contracts')
const { EnhancedTranscriptPlugin } = require('../../src/agent-core/formal/enhanced-transcript-plugin')
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
  assert.deepEqual(host.availableTaskKinds(), [
    'meeting-minutes', 'memory-extraction', 'enhanced-transcript'
  ])
  await assert.rejects(host.executeJob(job()), (error) => error.code === 'AGENT_INTERNAL_FAILURE')
  assert.equal(observedSignal.aborted, true)
  host.unload('meeting-minutes')
  assert.deepEqual(host.availableTaskKinds(), ['memory-extraction', 'enhanced-transcript'])
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
  assert.deepEqual(host.availableTaskKinds(), ['memory-extraction', 'enhanced-transcript'])
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

test('SEM-F13/F28 / J24-B28 enhanced transcript uses bounded multi-level merge without losing evidence', async () => {
  const plugin = new EnhancedTranscriptPlugin()
  const paragraphText = 'x'.repeat(360)
  const sample = {
    type: 'enhanced-transcript',
    content: {
      paragraphs: [{
        text: paragraphText,
        evidence: [{ fromEventOrder: 1, throughEventOrder: 1 }]
      }]
    }
  }
  const maxResultBytes = canonicalBytes(sample)
  const maxChunkInputBytes = canonicalBytes(mergeInput(INPUT_REF, Number.MAX_SAFE_INTEGER, [])) +
    (2 * maxResultBytes) + 1
  assert.equal(canonicalBytes(mergeInput(INPUT_REF, 0, [sample, sample])) <= maxChunkInputBytes, true)
  assert.equal(canonicalBytes(mergeInput(INPUT_REF, 0, [sample, sample, sample])) > maxChunkInputBytes, true)

  const operations = []
  const result = await plugin.generate({
    plan: {
      inputRef: { ...INPUT_REF, inputWatermark: 4 },
      chunks: [1, 2, 3, 4].map((eventOrder, chunkIndex) => ({
        chunkIndex,
        chunkCount: 4,
        segments: [{
          eventOrder,
          t0Ms: eventOrder - 1,
          t1Ms: eventOrder,
          fromCodePoint: 0,
          throughCodePoint: 1,
          text: 'x'
        }]
      }))
    },
    limits: { maxChunkInputBytes, maxResultBytes },
    invokeModel: async (operation, input) => {
      operations.push(operation)
      const ranges = operation === 'enhanced-transcript.chunk'
        ? input.segments.map((segment) => ({
            fromEventOrder: segment.eventOrder,
            throughEventOrder: segment.eventOrder
          }))
        : input.candidates.flatMap((candidate) => candidate.content.paragraphs)
          .flatMap((paragraph) => paragraph.evidence)
      return {
        type: 'enhanced-transcript',
        content: {
          paragraphs: [{
            text: paragraphText,
            evidence: [{
              fromEventOrder: Math.min(...ranges.map((range) => range.fromEventOrder)),
              throughEventOrder: Math.max(...ranges.map((range) => range.throughEventOrder))
            }]
          }]
        }
      }
    }
  })
  assert.equal(operations.filter((operation) => operation === 'enhanced-transcript.merge').length, 3)
  assert.deepEqual(result.content.paragraphs[0].evidence, [{
    fromEventOrder: 1,
    throughEventOrder: 4
  }])
})

test('SEM-F16 / J24-B19 unloading memory consolidation aborts active memory extraction', async () => {
  let releaseProvider
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const host = new AgentPluginHost({
    transcriptReader: { readSnapshot: async () => ({ inputRef: INPUT_REF, items: [item(1, 'memory input')] }) },
    inputPlanner: new AgentInputPlanner(),
    modelGateway: {
      getLimits: async () => ({ maxChunkInputBytes: 4096, maxResultBytes: 4096 }),
      execute: async () => {
        providerStarted()
        return new Promise((resolve) => { releaseProvider = resolve })
      }
    }
  })
  const running = host.executeJob(job({
    taskKind: 'memory-extraction',
    recipeVersion: 'memory-extraction@1'
  }))
  await started
  host.unload('memory-consolidation')
  releaseProvider({ type: 'memory-candidates', candidates: [] })
  await assert.rejects(running, (error) => error.code === 'AGENT_PLUGIN_INVALID')
  assert.deepEqual(host.availableTaskKinds(), ['meeting-minutes', 'enhanced-transcript'])
})

test('SEM-F16 / J24-B19 a disabled dependency keeps only compatible tasks executable', () => {
  const dependencies = {
    transcriptReader: { readSnapshot: async () => ({ inputRef: INPUT_REF, items: [item(1, 'input')] }) },
    inputPlanner: new AgentInputPlanner(),
    modelGateway: {
      getLimits: async () => ({ maxChunkInputBytes: 4096, maxResultBytes: 4096 }),
      execute: async () => { throw new Error('not invoked') }
    }
  }
  const withoutConsolidation = new AgentPluginHost({
    ...dependencies,
    disabledPluginIds: ['memory-consolidation']
  })
  assert.deepEqual(withoutConsolidation.availableTaskKinds(), [
    'meeting-minutes', 'enhanced-transcript'
  ])
  const withoutTranscript = new AgentPluginHost({
    ...dependencies,
    disabledPluginIds: ['transcript-context']
  })
  assert.deepEqual(withoutTranscript.availableTaskKinds(), [])
})
