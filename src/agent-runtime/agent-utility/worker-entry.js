'use strict'

const { OPERATIONS, failureResponse, requestEnvelope, successResponse } = require('./protocol')

function attachAgentUtilityWorker ({ service, parentPort = process.parentPort, exit = process.exit } = {}) {
  if (!service || typeof service.initialize !== 'function' || typeof service.executeJob !== 'function' ||
      typeof service.cancel !== 'function' || typeof service.shutdown !== 'function' ||
      !parentPort || typeof parentPort.on !== 'function' || typeof parentPort.postMessage !== 'function' ||
      typeof exit !== 'function') {
    throw new TypeError('invalid Agent utility worker entry')
  }

  let queue = Promise.resolve()
  let exiting = false
  const post = (message) => {
    if (exiting) return
    try {
      parentPort.postMessage(message)
    } catch {
      exiting = true
      setImmediate(() => exit(1))
    }
  }
  const handle = async (request) => {
    if (request.operation === OPERATIONS.INITIALIZE) return service.initialize(request.payload)
    if (request.operation === OPERATIONS.EXECUTE_JOB) return service.executeJob(request.payload)
    if (request.operation === OPERATIONS.SHUTDOWN) return service.shutdown(request.payload)
    throw new TypeError('unsupported queued Agent utility operation')
  }

  parentPort.on('message', (event) => {
    let request
    try {
      request = requestEnvelope(event.data)
    } catch (error) {
      exiting = true
      setImmediate(() => exit(1))
      return
    }

    if (request.operation === OPERATIONS.CANCEL) {
      try {
        post(successResponse(request.requestId, service.cancel(request.payload)))
      } catch (error) {
        post(failureResponse(request.requestId, error))
      }
      return
    }

    queue = queue.then(async () => {
      try {
        const result = await handle(request)
        post(successResponse(request.requestId, result))
        if (request.operation === OPERATIONS.SHUTDOWN) {
          exiting = true
          setImmediate(() => exit(0))
        }
      } catch (error) {
        if (error?.code === 'AGENT_WORKER_EXITED') {
          exiting = true
          setImmediate(() => exit(1))
          return
        }
        post(failureResponse(request.requestId, error))
      }
    }).catch(() => {
      exiting = true
      setImmediate(() => exit(1))
    })
  })
}

module.exports = { attachAgentUtilityWorker }
