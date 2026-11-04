'use strict'

const assert = require('node:assert/strict')

async function qualifyPiCore () {
  const { agentLoop } = await import('@earendil-works/pi-agent-core')
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
  assert.equal(require('@earendil-works/pi-agent-core/package.json').version, '0.84.1')
  const model = Object.freeze({ id: 'qualification', provider: 'controlled', api: 'openai-completions' })
  const counts = { requests: 0, tools: 0, turns: 0, active: 0, peak: 0 }
  const controller = new AbortController()
  const order = []
  const tools = ['first', 'second'].map(name => ({ name, label: name, description: name,
    parameters: { type: 'object', additionalProperties: false },
    execute: async () => {
      counts.active++; counts.peak = Math.max(counts.peak, counts.active)
      await new Promise(resolve => setImmediate(resolve))
      counts.tools++; order.push(name); counts.active--
      return { content: [{ type: 'text', text: '{}' }], details: {} }
    }
  }))
  const streamFn = async (boundModel, _context, options) => {
    assert.equal(boundModel, model)
    assert.equal(options.signal, controller.signal)
    assert.equal(controller.signal.aborted, false)
    counts.requests++
    const content = counts.requests === 1 ? tools.map((tool, index) => ({ type: 'toolCall',
      id: `call.${index}`, name: tool.name, arguments: {} })) : [{ type: 'text', text: '{}' }]
    const message = { role: 'assistant', content, stopReason: counts.requests === 1 ? 'toolUse' : 'stop',
      api: model.api, provider: model.provider, model: model.id, timestamp: 0, usage: {} }
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message)
    return stream
  }
  const config = { model, convertToLlm: messages => messages, toolExecution: 'sequential',
    beforeToolCall: ({ toolCall }) => { order.push(`before.${toolCall.name}`) },
    shouldStopAfterTurn: ({ toolResults }) => {
      counts.turns++
      if (counts.turns === 1) assert.equal(toolResults.length, 2)
      return counts.turns >= 2
    }
  }
  for await (const _event of agentLoop([{ role: 'user', content: 'JSON', timestamp: 0 }],
    { systemPrompt: '', messages: [], tools }, config, controller.signal, streamFn)) {}
  assert.deepEqual(order, ['before.first', 'first', 'before.second', 'second'])
  assert.equal(counts.requests, 2); assert.equal(counts.peak, 1); assert.equal(counts.turns, 2)

  const cancel = new AbortController()
  let cancelledTools = 0; let cancelledRequests = 0
  const cancelTools = tools.map(tool => ({ ...tool, execute: async () => {
    cancelledTools++; cancel.abort(); return { content: [{ type: 'text', text: '{}' }], details: {} }
  } }))
  for await (const _event of agentLoop([{ role: 'user', content: 'JSON', timestamp: 0 }],
    { systemPrompt: '', messages: [], tools: cancelTools },
    { ...config, shouldStopAfterTurn: () => cancel.signal.aborted }, cancel.signal, async () => {
      cancelledRequests++
      const stream = createAssistantMessageEventStream()
      const message = { role: 'assistant', content: cancelTools.map((tool, index) => ({ type: 'toolCall',
        id: `cancel.${index}`, name: tool.name, arguments: {} })), stopReason: 'toolUse', timestamp: 0, usage: {} }
      stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(message); return stream
    })) {}
  assert.equal(cancelledTools, 1); assert.equal(cancelledRequests, 1)
  let failures = 0
  for await (const _event of agentLoop([{ role: 'user', content: 'JSON', timestamp: 0 }],
    { systemPrompt: '', messages: [] }, config, undefined, async () => {
      failures++
      const stream = createAssistantMessageEventStream()
      const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'controlled', timestamp: 0, usage: {} }
      stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return stream
    })) {}
  assert.equal(failures, 1)
  return { requests: counts.requests, tools: counts.tools, turns: counts.turns, peakTools: counts.peak,
    cancelledTools, cancelledRequests, failedRequests: failures }
}

module.exports = { qualifyPiCore }

if (require.main === module || ['browser', 'utility'].includes(process.type)) {
  if (process.type === 'utility') {
    qualifyPiCore().then(report => {
      process.parentPort.postMessage(report)
      setImmediate(() => process.exit(0))
    }, () => process.exit(1))
  } else {
    const { app, utilityProcess } = require('electron')
    app.setPath('userData', process.argv[2])
    app.whenReady().then(async () => {
      await qualifyPiCore()
      const child = utilityProcess.fork(__filename, [], { stdio: 'pipe', serviceName: 'Pi qualification' })
      let received = false
      child.on('message', report => { received = true; process.stdout.write(JSON.stringify(report) + '\n') })
      child.once('exit', code => app.exit(received && code === 0 ? 0 : 1))
    }).catch(() => app.exit(1))
  }
}
