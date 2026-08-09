'use strict'

const { AgentExecutionService, OPERATIONS } = require('./agent-service')
const { requestEnvelope, failure, response } = require('./protocol')

const post = (message) => { try { process.parentPort.postMessage(message) } catch {} }
const service = new AgentExecutionService({
  emit: post,
  scenario: process.env.AGENT_MVP_SMOKE === '1' ? process.env.AGENT_MVP_SMOKE_SCENARIO : 'happy-restart',
  phase: process.env.AGENT_MVP_SMOKE_PHASE || 'first',
  hiddenThoughtCanary: process.env.AGENT_MVP_SMOKE === '1' ? (process.env.AGENT_MVP_SMOKE_THOUGHT || '') : ''
})
let queue = Promise.resolve()

process.parentPort.on('message', (event) => {
  let request
  try { request = requestEnvelope(event.data) } catch (error) { post(failure('', error)); return }
  if (request.operation === OPERATIONS.CANCEL) {
    try { post(response(request.requestId, service.cancel(request.payload.runId))) } catch (error) { post(failure(request.requestId, error)) }
    return
  }
  queue = queue.then(async () => {
    post(await service.handle(request))
    if (service.shuttingDown) setImmediate(() => process.exit(0))
  }).catch(() => setImmediate(() => process.exit(1)))
})
