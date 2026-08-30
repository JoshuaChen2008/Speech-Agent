'use strict'

// @ts-check

/* Main-process durability boundary for the subtitle storage utility process.
   -------------------------------------------------------------------------
   StorageWorkerHost intentionally owns only one utility-process generation.
   This gateway owns the logical FIFO above those generations: a request stays
   at the head until the worker acknowledges it, and an unknown transport
   outcome is replayed with the same cloned payload after the old worker has
   been confirmed dead. Business rejections are acknowledgements and are never
   hidden behind a blind worker restart. */

const path = require('node:path')
const {
  StorageWorkerHost,
  isStorageTransportError
} = require('../../runtime/storage-worker/worker-host')
const { StorageError } = require('../../runtime/storage-worker/protocol')

const DEFAULT_MAX_RESTARTS = 2
const DEFAULT_MAX_QUEUE = 4096
const DURABLE_WRITE_OPERATIONS = new Set([
  'openSession',
  'recordRefinementFault',
  'appendCaption',
  'closeSession',
  'recoverStaleSessions',
  'importLegacyJsonl'
])
const READ_ONLY_OPERATIONS = new Set([
  'getSessionTranscript',
  'getSessionPage',
  'listSessions',
  'getStats'
])
/* Agent 任务事实仍经同一 storage worker 串行写入，但确定性 Agent 业务拒绝
   只拒绝该请求，绝不能熔断字幕事实 FIFO。队满时这些低优先级请求也不占用
   为字幕 durable write 保留的溢出槽。未知传输结果仍以同一幂等身份重放。 */
const ISOLATED_AGENT_OPERATIONS = new Set([
  'evaluateAgentEligibility',
  'reconcileTerminalAgentSession',
  'readAgentInputSnapshot',
  'requestAgentJob',
  'claimNextAgentJob',
  'renewAgentJobLease',
  'markAgentJobRetry',
  'markAgentJobFailed',
  'requestAgentCancel',
  'markAgentJobCancelled',
  'commitAgentArtifact',
  'commitAgentMemoryCandidates',
  'readAgentMemoryContext',
  'applyAgentTaskPolicy',
  'getAgentSessionDetail',
  'deleteAgentSessionData',
  'personalContextIngest',
  'personalContextResolve',
  'personalContextManage',
  'deletePersonalContextSessionData',
  'claimNextFormalAgentRun',
  'nextFormalAgentRunAt',
  'completeFormalAgentRun',
  'failFormalAgentRun',
  'modelAccessCatalog',
  'modelAccessConfigure',
  'modelAccessBind'
])
const TRANSPORT_CODES = new Set([
  'NOT_INITIALIZED',
  'STORAGE_WORKER_EXITED',
  'STORAGE_REQUEST_TIMEOUT',
  'STORAGE_PROTOCOL_ERROR',
  'STORAGE_POST_FAILED'
])

function cloneForQueue (value) {
  return structuredClone(value)
}

function isTransportFailure (error) {
  if (!error || typeof error !== 'object') return false
  if (isStorageTransportError(error) || error.isStorageTransportError === true ||
      error.transport === true || error.name === 'StorageTransportError') return true
  if (typeof error.code === 'string' && TRANSPORT_CODES.has(error.code)) return true
  return false
}

function retainedFailure (error) {
  if (error && typeof error === 'object') error.storageRetained = true
  return error
}

class StorageGateway {
  #agentTaskPolicyHost

  constructor (options = {}) {
    if (typeof options.databasePath !== 'string' || !path.isAbsolute(options.databasePath)) {
      throw new TypeError('databasePath must be absolute')
    }
    const maxRestarts = options.maxRestarts === undefined
      ? DEFAULT_MAX_RESTARTS
      : options.maxRestarts
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 20) {
      throw new RangeError('maxRestarts must be an integer between 0 and 20')
    }
    if (options.hostFactory !== undefined && typeof options.hostFactory !== 'function') {
      throw new TypeError('hostFactory must be a function')
    }
    if (options.onFatalError !== undefined && typeof options.onFatalError !== 'function') {
      throw new TypeError('onFatalError must be a function')
    }
    const maxQueue = options.maxQueue === undefined ? DEFAULT_MAX_QUEUE : options.maxQueue
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 100000) {
      throw new RangeError('maxQueue must be an integer between 1 and 100000')
    }

    this.databasePath = options.databasePath
    this.maxRestarts = maxRestarts
    this.maxQueue = maxQueue
    this.hostOptions = { databasePath: this.databasePath }
    for (const key of ['electron', 'workerPath', 'requestTimeoutMs']) {
      if (options[key] !== undefined) this.hostOptions[key] = options[key]
    }
    if (options.onFatalError) this.hostOptions.onFatalError = options.onFatalError
    this.hostFactory = options.hostFactory || ((hostOptions) => new StorageWorkerHost(hostOptions))
    this.host = null
    this.#agentTaskPolicyHost = null
    this.hostInvalid = false
    this.startPromise = null
    this.queue = []
    this.nextSequence = 0
    this.processing = false
    this.accepting = true
    this.stopped = false
    this.faulted = false
    this.fault = null
    this.flushWaiters = new Set()
    this.shutdownPromise = null
  }

  createHost () {
    return this.hostFactory({ ...this.hostOptions })
  }

  async spawnHost () {
    if (this.stopped) throw new StorageError('SHUTTING_DOWN')
    const candidate = this.createHost()
    if (!candidate || typeof candidate.start !== 'function' ||
        typeof candidate.terminateAndWait !== 'function') {
      throw new TypeError('hostFactory must return a StorageWorkerHost-compatible object')
    }
    this.host = candidate
    this.#agentTaskPolicyHost = null
    this.hostInvalid = false
    try {
      await candidate.start()
    } catch (error) {
      this.hostInvalid = true
      try {
        await candidate.terminateAndWait()
        if (this.host === candidate) this.host = null
        this.hostInvalid = false
      } catch (terminationError) {
        /* Keep the exact candidate so retry() can attempt to retire it again.
           A fresh writer must never be created while its exit is unconfirmed. */
        throw terminationError
      }
      throw error
    }
  }

  async ensureHost () {
    if (this.startPromise) return this.startPromise
    if (this.host && !this.hostInvalid) return
    if (this.hostInvalid) throw new Error('storage host requires replacement')
    this.startPromise = this.spawnHost()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async replaceInvalidHost () {
    const stale = this.host
    if (stale) {
      await stale.terminateAndWait()
      if (this.host === stale) this.host = null
    }
    this.hostInvalid = false
    await this.ensureHost()
  }

  reportQueuedFailure (error) {
    for (const item of this.queue) {
      if (item.reported) continue
      item.reported = true
      item.reject(error)
    }
  }

  tripCircuit (error) {
    this.faulted = true
    this.fault = error instanceof Error ? error : new Error('storage gateway faulted')
    if (this.queue.length > 0) retainedFailure(this.fault)
    this.reportQueuedFailure(this.fault)
    this.rejectFlushWaiters(this.fault)
  }

  async start () {
    if (this.stopped || !this.accepting) throw new StorageError('SHUTTING_DOWN')
    if (this.faulted) throw this.fault
    let restarts = 0
    let lastError = null
    while (!this.stopped) {
      try {
        await this.ensureHost()
        return
      } catch (error) {
        if (!isTransportFailure(error)) throw error
        lastError = error
        if (this.hostInvalid && this.host) {
          if (restarts >= this.maxRestarts) break
          restarts += 1
          try {
            await this.replaceInvalidHost()
            return
          } catch (replacementError) {
            lastError = replacementError
            if (this.hostInvalid && this.host) break
            continue
          }
        }
        if (restarts >= this.maxRestarts) break
        restarts += 1
      }
    }
    this.tripCircuit(lastError || new Error('storage gateway could not start'))
    throw this.fault
  }

  enqueue (operation, value) {
    if (!this.accepting || this.stopped) return Promise.reject(new StorageError('SHUTTING_DOWN'))
    const durableWrite = DURABLE_WRITE_OPERATIONS.has(operation)
    /* maxQueue 是开始 fail-closed 的高水位，不是丢字幕边界。字幕写命令可以
       占用一个受保护溢出槽，closeSession 另有一个终态槽；该调用同步报错，
       使 Coordinator 在返回 worker 前进入 storage fault，同时队首仍保留到
       retry() 后获得 ACK。 */
    const protectedLimit = operation === 'closeSession'
      ? this.maxQueue + 2
      : durableWrite ? this.maxQueue + 1 : this.maxQueue
    if (this.queue.length >= protectedLimit) {
      return Promise.reject(new StorageError('STORAGE_QUEUE_FULL'))
    }
    if (this.faulted && !durableWrite) return Promise.reject(this.fault)
    let payload
    try {
      payload = cloneForQueue(value)
    } catch (error) {
      return Promise.reject(error)
    }

    let resolveItem
    let rejectItem
    const promise = new Promise((resolve, reject) => {
      resolveItem = resolve
      rejectItem = reject
    })
    const item = {
      sequence: ++this.nextSequence,
      operation,
      payload,
      promise,
      resolve: resolveItem,
      reject: rejectItem,
      restarts: 0,
      needsRecovery: false,
      lastError: null,
      reported: false
    }
    this.queue.push(item)
    const capacityTripped = durableWrite && this.queue.length > this.maxQueue
    if (this.faulted || capacityTripped) {
      const error = retainedFailure(this.faulted
        ? this.fault
        : new StorageError('STORAGE_QUEUE_FULL'))
      /* The caller receives a synchronous failure, so this retained item's
         private promise must still have an observer. retry()/flush() is the
         later durability acknowledgement for every reported queue item. */
      promise.catch(() => {})
      if (!this.faulted) this.tripCircuit(error)
      else {
        item.reported = true
        item.reject(error)
      }
      throw error
    }
    this.kick()
    return promise
  }

  openSession (input) {
    return this.enqueue('openSession', input)
  }

  appendCaption (event) {
    return this.enqueue('appendCaption', event)
  }

  closeSession (input) {
    return this.enqueue('closeSession', input)
  }

  recordRefinementFault (input) {
    return this.enqueue('recordRefinementFault', input)
  }

  recoverStaleSessions (input) {
    return this.enqueue('recoverStaleSessions', input)
  }

  importLegacyJsonl (input) {
    return this.enqueue('importLegacyJsonl', input)
  }

  getSessionTranscript (sessionId) {
    return this.enqueue('getSessionTranscript', sessionId)
  }

  getSessionPage (input) {
    return this.enqueue('getSessionPage', input)
  }

  listSessions (input) {
    return this.enqueue('listSessions', input)
  }

  getStats () {
    return this.enqueue('getStats', null)
  }

  evaluateAgentEligibility (input) {
    return this.enqueue('evaluateAgentEligibility', input)
  }

  reconcileTerminalAgentSession (input) {
    return this.enqueue('reconcileTerminalAgentSession', input)
  }

  readAgentInputSnapshot (input) {
    return this.enqueue('readAgentInputSnapshot', input)
  }

  requestAgentJob (input) {
    return this.enqueue('requestAgentJob', input)
  }

  claimNextAgentJob (input) {
    return this.enqueue('claimNextAgentJob', input)
  }

  renewAgentJobLease (input) {
    return this.enqueue('renewAgentJobLease', input)
  }

  markAgentJobRetry (input) {
    return this.enqueue('markAgentJobRetry', input)
  }

  markAgentJobFailed (input) {
    return this.enqueue('markAgentJobFailed', input)
  }

  requestAgentCancel (input) {
    return this.enqueue('requestAgentCancel', input)
  }

  markAgentJobCancelled (input) {
    return this.enqueue('markAgentJobCancelled', input)
  }

  commitAgentArtifact (input) {
    return this.enqueue('commitAgentArtifact', input)
  }

  commitAgentMemoryCandidates (input) {
    return this.enqueue('commitAgentMemoryCandidates', input)
  }

  readAgentMemoryContext (input) {
    return this.enqueue('readAgentMemoryContext', input)
  }

  applyAgentTaskPolicy (input) {
    return this.enqueue('applyAgentTaskPolicy', input)
  }

  isAgentTaskPolicyReady () {
    return this.host !== null &&
      this.host === this.#agentTaskPolicyHost &&
      this.hostInvalid === false &&
      this.host.state === 'ready'
  }

  getAgentSessionDetail (input) {
    return this.enqueue('getAgentSessionDetail', input)
  }

  deleteAgentSessionData (input) {
    return this.enqueue('deleteAgentSessionData', input)
  }

  personalContextIngest (source) {
    return this.enqueue('personalContextIngest', source)
  }

  personalContextResolve (request) {
    return this.enqueue('personalContextResolve', request)
  }

  personalContextManage (command) {
    return this.enqueue('personalContextManage', command)
  }

  deletePersonalContextSessionData (input) {
    return this.enqueue('deletePersonalContextSessionData', input)
  }

  claimNextFormalAgentRun (request) {
    return this.enqueue('claimNextFormalAgentRun', request)
  }

  nextFormalAgentRunAt () {
    return this.enqueue('nextFormalAgentRunAt', {})
  }

  completeFormalAgentRun (request) {
    return this.enqueue('completeFormalAgentRun', request)
  }

  failFormalAgentRun (request) {
    return this.enqueue('failFormalAgentRun', request)
  }

  modelAccessCatalog () {
    return this.enqueue('modelAccessCatalog', {})
  }

  modelAccessConfigure (input) {
    return this.enqueue('modelAccessConfigure', input)
  }

  modelAccessBind (request, availableSlotIds = []) {
    return this.enqueue('modelAccessBind', { request, availableSlotIds })
  }

  invoke (host, item) {
    switch (item.operation) {
      case 'openSession': return host.openSession(item.payload)
      case 'appendCaption': return host.appendCaption(item.payload)
      case 'closeSession': return host.closeSession(item.payload)
      case 'recordRefinementFault': return host.recordRefinementFault(item.payload)
      case 'recoverStaleSessions': return host.recoverStaleSessions(item.payload)
      case 'importLegacyJsonl': return host.importLegacyJsonl(item.payload)
      case 'getSessionTranscript': return host.getSessionTranscript(item.payload)
      case 'getSessionPage': return host.getSessionPage(item.payload)
      case 'listSessions': return host.listSessions(item.payload)
      case 'getStats': return host.getStats()
      case 'evaluateAgentEligibility': return host.evaluateAgentEligibility(item.payload)
      case 'reconcileTerminalAgentSession': return host.reconcileTerminalAgentSession(item.payload)
      case 'readAgentInputSnapshot': return host.readAgentInputSnapshot(item.payload)
      case 'requestAgentJob': return host.requestAgentJob(item.payload)
      case 'claimNextAgentJob': return host.claimNextAgentJob(item.payload)
      case 'renewAgentJobLease': return host.renewAgentJobLease(item.payload)
      case 'markAgentJobRetry': return host.markAgentJobRetry(item.payload)
      case 'markAgentJobFailed': return host.markAgentJobFailed(item.payload)
      case 'requestAgentCancel': return host.requestAgentCancel(item.payload)
      case 'markAgentJobCancelled': return host.markAgentJobCancelled(item.payload)
      case 'commitAgentArtifact': return host.commitAgentArtifact(item.payload)
      case 'commitAgentMemoryCandidates': return host.commitAgentMemoryCandidates(item.payload)
      case 'readAgentMemoryContext': return host.readAgentMemoryContext(item.payload)
      case 'applyAgentTaskPolicy': return host.applyAgentTaskPolicy(item.payload)
      case 'getAgentSessionDetail': return host.getAgentSessionDetail(item.payload)
      case 'deleteAgentSessionData': return host.deleteAgentSessionData(item.payload)
      case 'personalContextIngest': return host.personalContextIngest(item.payload)
      case 'personalContextResolve': return host.personalContextResolve(item.payload)
      case 'personalContextManage': return host.personalContextManage(item.payload)
      case 'deletePersonalContextSessionData': return host.deletePersonalContextSessionData(item.payload)
      case 'claimNextFormalAgentRun': return host.claimNextFormalAgentRun(item.payload)
      case 'nextFormalAgentRunAt': return host.nextFormalAgentRunAt()
      case 'completeFormalAgentRun': return host.completeFormalAgentRun(item.payload)
      case 'failFormalAgentRun': return host.failFormalAgentRun(item.payload)
      case 'modelAccessCatalog': return host.modelAccessCatalog()
      case 'modelAccessConfigure': return host.modelAccessConfigure(item.payload)
      case 'modelAccessBind': return host.modelAccessBind(item.payload.request, item.payload.availableSlotIds)
      default: throw new TypeError(`unsupported gateway operation: ${item.operation}`)
    }
  }

  kick () {
    if (this.processing || this.faulted || this.stopped || this.queue.length === 0) return
    this.processing = true
    void this.drain().catch((error) => this.tripCircuit(error)).finally(() => {
      this.processing = false
      if (!this.faulted && !this.stopped && this.queue.length > 0) this.kick()
      else if (this.queue.length === 0) this.resolveFlushWaiters()
    })
  }

  async drain () {
    while (!this.faulted && !this.stopped && this.queue.length > 0) {
      const item = this.queue[0]

      if (item.needsRecovery) {
        if (item.restarts >= this.maxRestarts) {
          this.tripCircuit(item.lastError || new Error('storage recovery exhausted'))
          return
        }
        item.restarts += 1
        try {
          await this.replaceInvalidHost()
          item.needsRecovery = false
        } catch (error) {
          item.lastError = error
          /* Failure to confirm the old host's exit is a hard boundary. Manual
             retry may try that exact retirement again; this drain may not
             create another writer. */
          if (this.hostInvalid && this.host) {
            this.tripCircuit(error)
            return
          }
          item.needsRecovery = true
          continue
        }
      }

      try {
        await this.ensureHost()
        const activeHost = this.host
        if (item.operation === 'reconcileTerminalAgentSession' && !this.isAgentTaskPolicyReady()) {
          throw new StorageError('AGENT_REQUEST_INVALID')
        }
        const result = await this.invoke(activeHost, item)
        if (this.stopped || this.queue[0] !== item) return
        if (item.operation === 'applyAgentTaskPolicy' && this.host === activeHost) {
          this.#agentTaskPolicyHost = activeHost
        }
        const clonedResult = cloneForQueue(result)
        this.queue.shift()
        if (!item.reported) item.resolve(clonedResult)
      } catch (error) {
        if (this.stopped || this.queue[0] !== item) return
        if (!isTransportFailure(error)) {
          if (READ_ONLY_OPERATIONS.has(item.operation) || ISOLATED_AGENT_OPERATIONS.has(item.operation)) {
            this.queue.shift()
            if (!item.reported) item.reject(error)
            /* 查询的确定性业务拒绝只属于该查询 promise。flush 是持久化
               FIFO 的排空屏障；只读失败既没有未知写入结果，也不能把并发
               close/shutdown 误报为落盘失败。继续处理后续队列，待实际排空
               后统一 resolve flush waiters。 */
            continue
          }
          /* 写命令的确定性拒绝表示事实序列存在程序/身份冲突。保留毒性队首
             并熔断，不能跳过该事实后继续 close，伪装成完整历史。 */
          this.tripCircuit(error)
          return
        }
        item.lastError = error
        item.needsRecovery = true
        this.hostInvalid = !!this.host
      }
    }
  }

  flush () {
    if (this.faulted) return Promise.reject(this.fault)
    if (this.queue.length === 0 && !this.processing) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.flushWaiters.add({ resolve, reject })
    })
  }

  resolveFlushWaiters () {
    if (this.queue.length > 0 || this.processing) return
    const waiters = [...this.flushWaiters]
    this.flushWaiters.clear()
    for (const waiter of waiters) waiter.resolve()
  }

  rejectFlushWaiters (error) {
    const waiters = [...this.flushWaiters]
    this.flushWaiters.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  async retry () {
    if (this.stopped) throw new StorageError('SHUTTING_DOWN')
    if (!this.faulted) return this.flush()
    this.faulted = false
    this.fault = null
    if (this.queue.length === 0) return this.start()
    const head = this.queue[0]
    head.restarts = 0
    this.kick()
    return this.flush()
  }

  async shutdown () {
    if (this.stopped) return
    this.accepting = false
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = (async () => {
      await this.flush()
      if (this.queue.length > 0 || this.faulted) {
        throw this.fault || new Error('storage queue is not durable')
      }
      const host = this.host
      if (host) {
        await host.shutdown()
        if (this.host === host) this.host = null
      }
      this.#agentTaskPolicyHost = null
      this.stopped = true
    })()
    try {
      await this.shutdownPromise
    } catch (error) {
      this.shutdownPromise = null
      throw error
    }
  }

  async terminate () {
    if (this.stopped && !this.host && this.queue.length === 0) return
    this.accepting = false
    this.stopped = true
    const error = new StorageError('SHUTTING_DOWN')
    const host = this.host
    let terminationError = null
    if (host) {
      try {
        await host.terminateAndWait()
      } catch (cause) {
        terminationError = cause
        if (cause?.code === 'TERMINATION_TIMEOUT' && typeof host.waitForExactExit === 'function') {
          try {
            await host.waitForExactExit()
            terminationError = null
          } catch (lateExitError) {
            terminationError = lateExitError
          }
        }
      }
      /* Keep the exact host reachable after any unconfirmed termination so a
         later quit attempt can continue joining it. */
      if (!terminationError && this.host === host) this.host = null
    }
    this.hostInvalid = false
    this.#agentTaskPolicyHost = null
    const pending = this.queue.splice(0)
    for (const item of pending) item.reject(error)
    this.rejectFlushWaiters(terminationError || error)
    if (terminationError) throw terminationError
  }
}

module.exports = {
  DEFAULT_MAX_QUEUE,
  DEFAULT_MAX_RESTARTS,
  StorageGateway,
  isTransportFailure
}
