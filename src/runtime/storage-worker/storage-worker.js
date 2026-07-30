'use strict'

// @ts-check

/* storage utility process 入口。协议/业务在 worker-service 中，本文只适配
   Electron parentPort 并保证请求串行；renderer 永远不能直连本端口。 */

const { StorageWorkerService } = require('./worker-service')

const service = new StorageWorkerService()
let commandQueue = Promise.resolve()

function post (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent exited */ }
}

process.parentPort.on('message', (event) => {
  commandQueue = commandQueue.then(() => {
    const response = service.handle(event.data)
    post(response)
    if (service.shuttingDown) setImmediate(() => process.exit(0))
  }).catch(() => {
    /* service.handle normalizes every expected failure. A queue-level failure is
       intentionally not echoed because it could contain a path or transcript. */
    setImmediate(() => process.exit(1))
  })
})
