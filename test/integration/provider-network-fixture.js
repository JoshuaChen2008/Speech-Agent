'use strict'

const { OpenAiCompatibleAdapter } = require('../../src/agent/model-access/openai-compatible-adapter')

// Upgrade existing controlled HTTP fixtures at the network boundary. The
// product adapter always consumes a byte stream; no text/json fallback is
// installed in production. Preserve deliberately hanging/late body fixtures.
function createNetworkAdapter (options) {
  const fetch = options.fetch
  return new OpenAiCompatibleAdapter({ ...options, fetch: async (...args) => {
    const response = await fetch(...args)
    if (!response || typeof response.body?.getReader === 'function') return response
    let consumed = false
    const body = new ReadableStream({
      async pull (controller) {
        if (consumed) return
        consumed = true
        const text = typeof response.text === 'function' ? await response.text()
          : typeof response.json === 'function' ? JSON.stringify(await response.json()) : ''
        controller.enqueue(Buffer.from(text, 'utf8'))
        controller.close()
      }
    }, { highWaterMark: 0 })
    return { ...response, body }
  } })
}

// Protocol regressions exercise the actual execution-host Pi runtime. This
// helper only binds a controlled network adapter to its single exchange.
function runAdapterLoop (adapter, { connection, credential, resolvedModel, requestStrategy, testMode, ...input }) {
  return require('../../src/agent/execution-host/pi-loop-runtime').runLoopExchange({ ...input,
    resolvedModel, requestStrategy, testMode,
    exchange: request => adapter.exchange({ ...request, connection, credential, resolvedModel, requestStrategy, testMode }) })
}

function runBoundLoop (runtime, binding, input = {}) {
  const handle = runtime.createLoopAdapter(binding)
  return require('../../src/agent/execution-host/pi-loop-runtime').runLoopExchange({ ...input,
    resolvedModel: handle.binding, requestStrategy: handle.requestStrategy, exchange: handle.exchange })
}

function providerResponse (content, toolCalls = [], usage = undefined) {
  return { ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }], ...(usage ? { usage } : {}) }) }
}

function toolRequest (name, args, id = 'call.synthetic') {
  return providerResponse(null, [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }])
}

function summaryStageContent (prompt, legacyMinutes) {
  const stage = JSON.parse(prompt).summaryPlan?.stage
  if (!stage) return legacyMinutes
  if (stage === 'organizing_topics') return { schemaVersion: 1, topics: [] }
  return { ...legacyMinutes, schemaVersion: 2, topics: [],
    conclusions: legacyMinutes.conclusions.map(item => ({ ...item, topicId: null })),
    todos: legacyMinutes.todos.map(item => ({ ...item, topicId: null })),
    risks: legacyMinutes.risks.map(item => ({ ...item, topicId: null })) }
}

function createRecipeNetworkAdapter (readRecipe, respond) {
  const { AsyncLocalStorage } = require('node:async_hooks')
  const context = new AsyncLocalStorage()
  const adapter = createNetworkAdapter({ fetch: async (_url, options) => {
    const recipe = await readRecipe(context.getStore().runId)
    const body = JSON.parse(options.body)
    const prompt = body.messages.find(message => message.role === 'user').content
    const observation = body.messages.at(-1).role === 'tool' ? JSON.parse(body.messages.at(-1).content) : null
    return respond({ recipe, prompt, body, observation, resolvedModel: context.getStore(), signal: options.signal })
  } })
  const exchange = adapter.exchange.bind(adapter)
  adapter.exchange = input => context.run(input.resolvedModel, () => exchange(input))
  return adapter
}

module.exports = { createNetworkAdapter, runAdapterLoop, runBoundLoop, providerResponse, toolRequest, createRecipeNetworkAdapter, summaryStageContent }
