'use strict'

const path = require('node:path')
const { AgentCoreError } = require('../agent-core/errors')
const { VERSION } = require('./protocol')

class RpcUtilityHost {
  constructor ({ electron, workerPath, serviceName, onEvent = () => {}, timeoutMs = 35000 }) {
    this.electron = electron; this.workerPath = path.resolve(workerPath); this.serviceName = serviceName
    this.onEvent = onEvent; this.timeoutMs = timeoutMs; this.child = null; this.pending = new Map(); this.counter = 0; this.exited = null
    this.exitPromise = Promise.resolve()
  }

  start () {
    if (this.child) return
    const child = this.electron.utilityProcess.fork(this.workerPath, [], { serviceName: this.serviceName })
    this.child = child
    let resolveExit
    this.exitPromise = new Promise((resolve) => { resolveExit = resolve })
    child.on('message', (message) => this.handleMessage(message))
    child.once('exit', () => {
      if (this.child === child) this.child = null
      for (const pending of this.pending.values()) pending.reject(new AgentCoreError('AGENT_WORKER_EXITED'))
      this.pending.clear()
      resolveExit()
    })
  }

  handleMessage (message) {
    if (message?.version === VERSION && message?.type === 'agent-mvp:event') { this.onEvent(message); return }
    if (message?.version !== VERSION || message?.type !== 'agent-mvp:response' || typeof message.requestId !== 'string' || typeof message.ok !== 'boolean') return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(message.requestId)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new AgentCoreError(message.error?.code || 'AGENT_INTERNAL_FAILURE'))
  }

  request (operation, payload, timeoutMs = this.timeoutMs) {
    if (!this.child) return Promise.reject(new AgentCoreError('AGENT_WORKER_EXITED'))
    const requestId = `${this.serviceName}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new AgentCoreError('AGENT_PROVIDER_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try { this.child.postMessage({ version: VERSION, type: 'agent-mvp:request', requestId, operation, payload }) } catch {
        clearTimeout(timer); this.pending.delete(requestId); reject(new AgentCoreError('AGENT_WORKER_EXITED'))
      }
    })
  }

  async stop (operation) {
    const child = this.child
    if (!child) return
    try { await this.request(operation, {}, 5000) } catch {}
    const waitForExit = async (timeoutMs) => {
      let timer
      const result = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
      ])
      clearTimeout(timer)
      return result
    }
    if (!await waitForExit(2000) && this.child === child) child.kill()
    if (!await waitForExit(3000)) throw new AgentCoreError('AGENT_WORKER_EXITED')
    if (this.child === child) this.child = null
  }
}

module.exports = { RpcUtilityHost }
