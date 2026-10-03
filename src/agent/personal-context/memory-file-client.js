'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')
class MemoryFileClient {
  constructor () {
    this.worker = null; this.pending = new Map(); this.sequence = 0
    this.configuration = null; this.ready = null
  }
  start () {
    if (this.worker) return
    const env = {}
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
    const worker = this.worker = new Worker(path.join(__dirname, 'memory-file-worker.js'), { env })
    worker.unref()
    worker.on('message', message => {
      const task = this.pending.get(message.id); if (!task) return
      this.pending.delete(message.id); clearTimeout(task.timer)
      if (!this.pending.size) worker.unref()
      if (message.error) task.reject(Object.assign(new Error(message.error), { code: message.error }))
      else task.resolve(message.result)
    })
    const fail = () => {
      if (this.worker !== worker) return
      if (this.worker === worker) this.worker = null
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(Object.assign(new Error('MEMORY_FILE_WORKER_EXITED'), { code: 'MEMORY_FILE_WORKER_EXITED' })) }
      this.pending.clear()
    }
    worker.on('error', fail); worker.on('exit', fail)
    this.ready = this.configuration ? this.rawCall(this.configuration) : Promise.resolve()
    this.ready.catch(() => {})
  }
  async call (input) {
    this.start()
    await this.ready
    const result = await this.rawCall(input)
    if (input.type === 'configure') this.configuration = structuredClone(input)
    return result
  }
  rawCall (input) {
    if (this.pending.size >= 16) return Promise.reject(Object.assign(new Error('MEMORY_FILE_BUSY'), { code: 'MEMORY_FILE_BUSY' }))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close() }, 10000)
      this.pending.set(id, { resolve, reject, timer }); this.worker.ref()
      this.worker.postMessage({ id, input })
    })
  }
  async close () { const worker = this.worker; if (worker) await worker.terminate() }
}
module.exports = { MemoryFileClient }
