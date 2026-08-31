'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createControlledToolRuntime } = require('../../src/agent/execution-host/controlled-tool-runtime')
const { createToolAuditRuntime } = require('../../src/agent/execution-host/tool-audit-runtime')
const { deriveRecipeBudget } = require('../../src/agent/contracts/budget-axes')

const source = { sessionId: 'session.tool.audit', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }
const memory = { memoryId: 'memory.tool.audit', revisionId: 'revision.tool.audit' }
const context = {
  scope: { registeredAliasKeys: ['decision'], memoryRefs: [memory], sourceRefs: [source] },
  entries: [{ aliasKey: 'decision', memoryRef: memory, kind: 'decision', displayText: 'A bounded decision.', sourceRefs: [source] }],
  sources: [{ sourceRef: source, text: 'A bounded source excerpt.' }]
}

test('SEM-F28/SEM-F34/J22/J24: tool audit records an ordered successful call with contract-derived metadata', async () => {
  const calls = []
  let now = 10
  const controlled = createControlledToolRuntime({ context })
  const audit = createToolAuditRuntime({
    interactionId: 'interaction.tool.audit', recipeId: 'qa.answer', recipeVersion: '1', attempt: 1,
    tools: controlled.toolsForRecipe('qa.answer', '1'),
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'qa.answer', '1', 'user'),
    interactions: {
      startToolCall: async (value) => { calls.push(['start', value]); return value },
      finishToolCall: async (value) => { calls.push(['finish', value]); return value }
    },
    now: () => now++
  })
  const result = await audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  assert.equal(result.matches[0].entries[0].displayText, 'A bounded decision.')
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].callOrder, 1)
  assert.equal(calls[1][1].status, 'succeeded')
  assert.equal(calls[1][1].counts.sourceTextBytes, 0)
  assert.equal(calls[1][1].sourceRefs[0].sessionId, 'session.tool.audit')
})

test('SEM-F28/SEM-F34/SEM-T04/J22: tool audit closes a failed call with a registered tool error', async () => {
  const calls = []
  const audit = createToolAuditRuntime({
    interactionId: 'interaction.tool.failure', recipeId: 'qa.answer', recipeVersion: '1', attempt: 1,
    tools: [{ name: 'search_context', execute: async () => { const error = new Error('bad args'); error.code = 'TOOL_ARGS_INVALID'; throw error } }],
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'qa.answer', '1', 'user'),
    interactions: {
      startToolCall: async (value) => { calls.push(['start', value]); return value },
      finishToolCall: async (value) => { calls.push(['finish', value]); return value }
    },
    now: () => 10
  })
  await assert.rejects(audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] }), (error) => error.code === 'TOOL_ARGS_INVALID')
  assert.deepEqual(calls.map(([kind, value]) => [kind, value.status, value.errorCode]), [
    ['start', undefined, undefined],
    ['finish', 'failed', 'TOOL_ARGS_INVALID']
  ])
})

test('SEM-F28/SEM-F34/SEM-T04/J22/J24: a tool timeout closes one audit record and rejects its late success', async () => {
  const calls = []
  let timeout = null
  let release
  const toolResult = new Promise((resolve) => { release = resolve })
  const audit = createToolAuditRuntime({
    interactionId: 'interaction.tool.timeout', recipeId: 'qa.answer', recipeVersion: '1', attempt: 1,
    tools: [{ name: 'search_context', execute: async () => toolResult }],
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'qa.answer', '1', 'user'),
    interactions: {
      startToolCall: async (value) => { calls.push(['start', value]); return value },
      finishToolCall: async (value) => { calls.push(['finish', value]); return value }
    },
    scheduleTimeout: (callback) => { timeout = callback; return 'timer' },
    cancelTimeout: () => {},
    now: () => 10
  })
  const pending = audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  await Promise.resolve()
  assert.equal(typeof timeout, 'function')
  timeout()
  release({ schemaVersion: 1, matches: [], unmatchedAliasKeys: ['decision'] })
  await assert.rejects(pending, (error) => error.code === 'TOOL_TIMEOUT')
  assert.deepEqual(calls.map(([kind, value]) => [kind, value.status, value.errorCode]), [
    ['start', undefined, undefined],
    ['finish', 'failed', 'TOOL_TIMEOUT']
  ])
})

test('SEM-F28/SEM-F34/SEM-T04/J22/J24: cancellation closes one audit record and rejects its late success', async () => {
  const calls = []
  let release
  const controller = new AbortController()
  const toolResult = new Promise((resolve) => { release = resolve })
  const audit = createToolAuditRuntime({
    interactionId: 'interaction.tool.cancelled', recipeId: 'qa.answer', recipeVersion: '1', attempt: 1,
    tools: [{ name: 'search_context', execute: async () => toolResult }],
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'qa.answer', '1', 'user'),
    interactions: {
      startToolCall: async (value) => { calls.push(['start', value]); return value },
      finishToolCall: async (value) => { calls.push(['finish', value]); return value }
    },
    signal: controller.signal,
    now: () => 10
  })
  const pending = audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  await Promise.resolve()
  controller.abort()
  release({ schemaVersion: 1, matches: [], unmatchedAliasKeys: ['decision'] })
  await assert.rejects(pending, (error) => error.code === 'TOOL_CANCELLED')
  assert.deepEqual(calls.map(([kind, value]) => [kind, value.status, value.errorCode]), [
    ['start', undefined, undefined],
    ['finish', 'cancelled', 'TOOL_CANCELLED']
  ])
})

test('SEM-F28/SEM-F34/SEM-T04/J22/J24: the second simultaneous tool call is rejected before tool execution', async () => {
  const calls = []
  let release
  const held = new Promise((resolve) => { release = resolve })
  let executions = 0
  const audit = createToolAuditRuntime({
    interactionId: 'interaction.tool.parallel', recipeId: 'qa.answer', recipeVersion: '1', attempt: 1,
    tools: [{
      name: 'search_context',
      execute: async () => {
        executions += 1
        await held
        return { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['decision'] }
      }
    }],
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'qa.answer', '1', 'user'),
    interactions: {
      startToolCall: async (value) => { calls.push(['start', value]); return value },
      finishToolCall: async (value) => { calls.push(['finish', value]); return value }
    },
    now: () => 10
  })
  const first = audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  const second = audit.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  await Promise.resolve()
  release()
  await first
  await assert.rejects(second, (error) => error.code === 'TOOL_BUDGET_EXCEEDED')
  assert.equal(executions, 1)
  assert.deepEqual(calls.filter(([kind]) => kind === 'finish').map(([, value]) => value.errorCode), [
    'TOOL_BUDGET_EXCEEDED', null
  ])
})
