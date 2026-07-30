'use strict'

// @ts-check

/* SessionCoordinator -> TranscriptStore 的低频组合边界。
   抽成独立模块后，产品组合根与 CI 用户旅程使用同一份接线逻辑，避免
   “各模块单测都通过，但会话没有开档/定稿没有落盘”的集成缺口。 */

class SessionTranscriptRecorder {
  constructor (options) {
    if (!options || !options.coordinator || typeof options.coordinator.onSnapshot !== 'function' ||
        typeof options.coordinator.onCaption !== 'function') {
      throw new TypeError('coordinator with snapshot and caption subscriptions is required')
    }
    if (!options.store || typeof options.store.openSession !== 'function' ||
        typeof options.store.append !== 'function' || typeof options.store.closeSession !== 'function') {
      throw new TypeError('transcript store is required')
    }

    this.store = options.store
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.sessionId = null
    this.disposed = false
    this.unsubscribeSnapshot = options.coordinator.onSnapshot((snapshot) => this.acceptSnapshot(snapshot))
    this.unsubscribeCaption = options.coordinator.onCaption((event) => this.acceptCaption(event))
  }

  reportError (error) {
    try { this.onError(error) } catch { /* observer failures stay isolated */ }
  }

  acceptSnapshot (snapshot) {
    if (this.disposed) return
    if (snapshot.sessionId && snapshot.sessionId !== this.sessionId) {
      /* 开档成功后才更新游标。若磁盘暂时失败，下一次同会话 snapshot 会重试。 */
      try {
        this.store.openSession(snapshot.sessionId)
        this.sessionId = snapshot.sessionId
      } catch (error) {
        this.reportError(error)
      }
    } else if (!snapshot.sessionId && this.sessionId) {
      this.sessionId = null
      this.store.closeSession()
    }
  }

  acceptCaption (event) {
    if (this.disposed || event.kind === 'partial') return false
    return this.store.append(event)
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSnapshot()
    this.unsubscribeCaption()
    this.sessionId = null
    this.store.closeSession()
  }
}

module.exports = { SessionTranscriptRecorder }
