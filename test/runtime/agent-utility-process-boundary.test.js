'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { AgentUtilityService } = require('../../src/agent-runtime/agent-utility/service')
const { attachAgentUtilityWorker } = require('../../src/agent-runtime/agent-utility/worker-entry')
const { AgentUtilityWorkerHost } = require('../../src/agent-runtime/agent-utility/worker-host')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  TASK_KINDS,
  successResponse
} = require('../../src/agent-runtime/agent-utility/protocol')

function nextImmediate () {
  return new Promise((resolve) => setImmediate(resolve))
}

class ControlledUtilityChild extends EventEmitter {
  constructor () {
    super()
    this.requests = []
    this.killed = false
    this.lateResponseRequestId = null
  }

  postMessage (request) {
    this.requests.push(request)
    if (request.operation === OPERATIONS.INITIALIZE) {
      queueMicrotask(() => {
        this.emit('message', successResponse(request.requestId, {
          availableTaskKinds: [...TASK_KINDS]
        }))
      })
    }
  }

  kill () {
    if (this.killed) return
    this.killed = true
    const pending = this.requests.find((request) => request.operation === OPERATIONS.CANCEL)
    if (pending) {
      this.lateResponseRequestId = pending.requestId
      this.emit('message', successResponse(pending.requestId, {
        runId: pending.payload.runId,
        cancelled: false
      }))
    }
    this.emit('exit', 86)
  }
}

test('Agent utility generation rejects pending work before an unknown response can race the original late success', async () => {
  const child = new ControlledUtilityChild()
  let failureNotifications = 0
  const host = new AgentUtilityWorkerHost({
    electron: { utilityProcess: { fork: () => child } },
    environment: { NODE_ENV: 'test' },
    requestTimeoutMs: 1000
  })
  host.observeGenerationFailure(() => { failureNotifications += 1 })

  await host.start()
  let lateResultAccepted = false
  const pending = host.perform(
    OPERATIONS.CANCEL,
    { runId: 'late-run' },
    (result) => {
      lateResultAccepted = true
      return result
    }
  )
  const originalRequestId = child.requests.at(-1).requestId

  child.emit('message', successResponse('unknown-request', { accepted: true }))

  await assert.rejects(pending, (error) => error?.code === 'AGENT_WORKER_EXITED')
  assert.equal(await host.waitForExactExit(), 86)
  assert.equal(lateResultAccepted, false)
  assert.equal(child.lateResponseRequestId, originalRequestId)
  assert.equal(failureNotifications, 1)
  assert.equal(child.killed, true)
})

test('Agent utility process clears invocation credentials and exits when its environment gains a provider credential', async () => {
  const environment = {}
  const service = new AgentUtilityService({ environment })
  service.initialize({})
  const parentPort = new EventEmitter()
  const responses = []
  let exitCode = null
  parentPort.postMessage = (message) => { responses.push(message) }
  attachAgentUtilityWorker({
    service,
    parentPort,
    exit: (code) => { exitCode = code }
  })

  environment.DEEPSEEK_API_KEY = 'unexpected'
  const credentialBytes = Uint8Array.from([11, 22, 33, 44])
  parentPort.emit('message', {
    data: {
      version: PROTOCOL_VERSION,
      type: 'agent-utility:request',
      requestId: 'environment-contamination',
      operation: OPERATIONS.EXECUTE_JOB,
      payload: { credentialBytes }
    }
  })

  await nextImmediate()
  await nextImmediate()
  assert.equal(exitCode, 1)
  assert.deepEqual([...credentialBytes], [0, 0, 0, 0])
  assert.deepEqual(responses, [])
})
