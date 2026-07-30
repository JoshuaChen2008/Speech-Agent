'use strict'

// @ts-check

/* 精修请求/响应的纯状态机。
   Electron MessagePort 只作为鸭子类型依赖注入；暂停期缓冲、resume ack 顺序、
   end 截止与死端口清理由这里统一维护，因此可直接用 node:test 回归。 */

class RefinementController {
  /**
   * @param {{
   *   emitRefined: (info: *, text: string) => * | null,
   *   publish: (message: *) => void,
   *   maxPending?: number
   * }} options
   */
  constructor (options) {
    if (!options || typeof options.emitRefined !== 'function' || typeof options.publish !== 'function') {
      throw new TypeError('emitRefined and publish are required')
    }
    const maxPending = options.maxPending === undefined ? 3 : options.maxPending
    if (!Number.isInteger(maxPending) || maxPending <= 0) {
      throw new TypeError('maxPending must be a positive integer')
    }

    this.emitRefined = options.emitRefined
    this.publish = options.publish
    this.maxPending = maxPending
    this.enabled = false
    this.accepting = true
    this.paused = false
    this.port = null
    this.nextRequestId = 1
    this.pending = new Map()
    this.skipped = 0
    this.failed = 0
    this.emptyResults = 0
    this.bufferedWhilePaused = []
  }

  metrics () {
    return {
      pending: this.pending.size,
      skipped: this.skipped,
      failed: this.failed,
      emptyResults: this.emptyResults
    }
  }

  /** MessagePortMain-compatible attachment; no Electron import is required. */
  attachPort (port) {
    if (this.port) {
      try { this.port.close() } catch { /* already closed */ }
      /* close may be delivered asynchronously, so retire the old generation now. */
      this.pending.clear()
    }
    this.port = port
    port.on('message', (event) => this.onMessage(event.data))
    port.on('close', () => this.onPortClosed(port))
    port.start()
  }

  onPortClosed (port) {
    if (this.port !== port) return
    this.port = null
    this.pending.clear()
  }

  request (info) {
    if (!this.accepting || !this.port || this.pending.size >= this.maxPending) {
      this.skipped += 1
      return false
    }

    let sampleCount = 0
    for (const chunk of info.chunks) sampleCount += chunk.length
    const samples = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of info.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }

    const requestId = this.nextRequestId++
    this.pending.set(requestId, {
      sourceId: info.sourceId,
      segmentId: info.segmentId,
      baseRevision: info.baseRevision,
      t0: info.t0,
      t1: info.t1
    })
    try {
      this.port.postMessage({ type: 'refine', requestId, sampleCount, samples })
      return true
    } catch {
      this.pending.delete(requestId)
      this.skipped += 1
      return false
    }
  }

  onMessage (message) {
    if (message?.type === 'refined') {
      const info = this.pending.get(message.requestId)
      this.pending.delete(message.requestId)
      if (!info) return
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      if (text.length === 0) {
        this.emptyResults += 1
        return
      }
      const event = this.emitRefined(info, text)
      if (!event) return
      if (this.paused) this.bufferedWhilePaused.push(event)
      else this.publish({ type: 'caption', event })
    } else if (message?.type === 'refine-failed') {
      this.pending.delete(message.requestId)
      this.failed += 1
    }
  }

  pause () {
    this.paused = true
  }

  /** ack 回调同步完成后才补发，锁定 coordinator 已回到 listening 的时序。 */
  resume (acknowledge) {
    this.paused = false
    acknowledge()
    this.flushBuffered()
  }

  /** 先截止请求，再收束当前段；收束回调触发的精修请求因此必然跳过。 */
  end (flushCurrent) {
    this.accepting = false
    flushCurrent()
    this.flushBuffered()
    this.pending.clear()
  }

  flushBuffered () {
    for (const event of this.bufferedWhilePaused) this.publish({ type: 'caption', event })
    this.bufferedWhilePaused = []
  }

  dispose () {
    this.accepting = false
    this.pending.clear()
    this.bufferedWhilePaused = []
    const port = this.port
    this.port = null
    if (port) {
      try { port.close() } catch { /* already closed */ }
    }
  }
}

module.exports = { RefinementController }
