'use strict'

const { AgentStorageService } = require('./storage-service')

const service = new AgentStorageService()
let queue = Promise.resolve()
const post = (message) => { try { process.parentPort.postMessage(message) } catch {} }

process.parentPort.on('message', (event) => {
  queue = queue.then(() => post(service.handle(event.data))).then(() => {
    if (service.shuttingDown) setImmediate(() => process.exit(0))
  }).catch(() => setImmediate(() => process.exit(1)))
})
