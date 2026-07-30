'use strict'

/* Electron-only deterministic transport-fault wrapper used by the storage
   gateway CI smoke. It runs the production WorkerService/SQLite store and
   drops exactly one caption response either before or after the service call,
   selected by the isolated database filename. No fault command is exposed in
   the production protocol. */

const fs = require('node:fs')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const service = new StorageWorkerService()
let commandQueue = Promise.resolve()
let databasePath = null

function post (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent exited */ }
}

function markerPath () {
  return `${databasePath}.transport-drop-once`
}

function shouldDrop (operation) {
  return operation === 'caption:append' && databasePath && !fs.existsSync(markerPath())
}

function markDrop () {
  fs.writeFileSync(markerPath(), 'transport fault injected\n', { flag: 'wx' })
}

process.parentPort.on('message', (event) => {
  commandQueue = commandQueue.then(() => {
    const request = event.data
    if (request?.operation === 'storage:initialize') databasePath = request.payload?.databasePath || null

    if (shouldDrop(request?.operation) && databasePath.includes('drop-before-commit')) {
      markDrop()
      process.exit(31)
      return
    }

    const response = service.handle(request)
    if (shouldDrop(request?.operation) && databasePath.includes('drop-after-commit')) {
      markDrop()
      process.exit(32)
      return
    }
    post(response)
    if (service.shuttingDown) setImmediate(() => process.exit(0))
  }).catch(() => setImmediate(() => process.exit(1)))
})
