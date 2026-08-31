'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createControlledToolRuntime } = require('../../src/agent/execution-host/controlled-tool-runtime')

const source = Object.freeze({
  sessionId: 'session.tool.runtime',
  transcriptVersion: 'raw',
  fromEventOrder: 1,
  throughEventOrder: 2
})
const memory = Object.freeze({ memoryId: 'memory.tool.runtime', revisionId: 'revision.tool.runtime' })
const context = Object.freeze({
  scope: Object.freeze({
    registeredAliasKeys: Object.freeze(['decision']),
    memoryRefs: Object.freeze([memory]),
    sourceRefs: Object.freeze([source])
  }),
  entries: Object.freeze([Object.freeze({
    aliasKey: 'decision',
    memoryRef: memory,
    kind: 'decision',
    displayText: 'A bounded decision.',
    sourceRefs: Object.freeze([source])
  })]),
  sources: Object.freeze([Object.freeze({ sourceRef: source, text: 'A bounded source excerpt.' })])
})

test('SEM-F15/SEM-F34/J22/J24: controlled tools read only the frozen personal-context projection', async () => {
  const runtime = createControlledToolRuntime({ context })
  const tools = runtime.toolsForRecipe('report.analysis', '1')
  assert.deepEqual(tools.map((tool) => tool.name), ['search_context', 'read_sources'])
  const search = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  assert.deepEqual(search, {
    schemaVersion: 1,
    matches: [{
      aliasKey: 'decision',
      entries: [{ memoryRef: memory, kind: 'decision', displayText: 'A bounded decision.', sourceRefs: [source] }]
    }],
    unmatchedAliasKeys: []
  })
  const read = await tools[1].execute({ schemaVersion: 1, sourceRefs: [source] })
  assert.deepEqual(read, { schemaVersion: 1, sources: [{ sourceRef: source, text: 'A bounded source excerpt.' }] })
  assert.deepEqual(runtime.toolsForRecipe('text.rewrite', '1'), [])
})

test('SEM-F15/SEM-F34/SEM-T04/J22: controlled tools reject outside scope and cancellation without widening the frozen projection', async () => {
  assert.throws(() => createControlledToolRuntime({
    context: {
      ...context,
      entries: [{ ...context.entries[0], memoryRef: { memoryId: 'memory.outside', revisionId: 'revision.tool.runtime' } }]
    }
  }), (error) => error.code === 'TOOL_SCOPE_DENIED')

  const controller = new AbortController()
  controller.abort()
  const runtime = createControlledToolRuntime({ context, signal: controller.signal })
  await assert.rejects(
    runtime.toolsForRecipe('qa.answer', '1')[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] }),
    (error) => error.code === 'TOOL_CANCELLED'
  )
})

test('SEM-F15/SEM-F28/J22: controlled tools retain a private frozen context snapshot for one fixed recipe run', async () => {
  const mutable = JSON.parse(JSON.stringify(context))
  const runtime = createControlledToolRuntime({ context: mutable })
  mutable.sources[0].text = 'Changed after the run began.'
  mutable.entries[0].displayText = 'Changed after the run began.'
  const [search, read] = runtime.toolsForRecipe('report.analysis', '1')
  assert.equal((await search.execute({ schemaVersion: 1, aliasKeys: ['decision'] })).matches[0].entries[0].displayText, 'A bounded decision.')
  assert.equal((await read.execute({ schemaVersion: 1, sourceRefs: [source] })).sources[0].text, 'A bounded source excerpt.')
})
