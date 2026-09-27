'use strict'

// @ts-check

/* storage utility process 入口。普通协议命令按 FIFO 执行；取消与租约续期
   控制消息可在分页读取的让出点处理。renderer 永远不能直连本端口。 */

const { StorageWorkerService } = require('./worker-service')
const { CONTROL_MESSAGES } = require('./protocol')

const service = new StorageWorkerService()
let commandQueue = Promise.resolve()

function post (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent exited */ }
}

process.parentPort.on('message', (event) => {
  if (event?.data?.type === CONTROL_MESSAGES.CANCEL_PERSONAL_CONTEXT_READ) {
    service.cancelPersonalContextReadControl(event.data)
    return
  }
  if (event?.data?.type === CONTROL_MESSAGES.RENEW_FORMAL_AGENT_RUN_LEASE) {
    const response = service.handleLeaseRenewalControl(event.data)
    post(response)
    return
  }
  commandQueue = commandQueue.then(async () => {
    const response = await service.handle(event.data)
    post(response)
    if (service.shuttingDown) setImmediate(() => process.exit(0))
  }).catch(() => {
    /* service.handle normalizes every expected failure. A queue-level failure is
       intentionally not echoed because it could contain a path or transcript. */
    setImmediate(() => process.exit(1))
  })
})
