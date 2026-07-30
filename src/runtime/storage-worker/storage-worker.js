'use strict'

// @ts-check

/* storage utility process 入口。DB0 只开放受控资格命令；正式存储 RPC 将在
   DB1 之后接入，renderer 永远不能传数据库路径、SQL 或 migration。 */

const { runDatabaseQualification } = require('./qualification')

const PROTOCOL_VERSION = 1
let commandQueue = Promise.resolve()
let shuttingDown = false

function post (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent exited */ }
}

function failure (requestId, error) {
  return {
    version: PROTOCOL_VERSION,
    type: 'storage:response',
    requestId,
    ok: false,
    error: {
      code: 'STORAGE_COMMAND_FAILED',
      message: String(error?.message || error).slice(0, 240)
    }
  }
}

async function handle (message) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
  if (message?.version !== PROTOCOL_VERSION || message?.type !== 'storage:request' || requestId.length === 0) {
    post(failure(requestId, new Error('invalid storage protocol envelope')))
    return
  }
  if (message.operation === 'db0:qualify') {
    try {
      const result = runDatabaseQualification(message.databasePath)
      post({ version: PROTOCOL_VERSION, type: 'storage:response', requestId, ok: true, result })
    } catch (error) {
      post(failure(requestId, error))
    }
    return
  }
  if (message.operation === 'shutdown') {
    shuttingDown = true
    post({ version: PROTOCOL_VERSION, type: 'storage:response', requestId, ok: true, result: { stopped: true } })
    setImmediate(() => process.exit(0))
    return
  }
  post(failure(requestId, new Error('unsupported storage operation')))
}

process.parentPort.on('message', (event) => {
  if (shuttingDown) return
  commandQueue = commandQueue.then(() => handle(event.data)).catch((error) => {
    post(failure('', error))
  })
})

