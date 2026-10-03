'use strict'

// The lightweight worker owns retention. At most one credited frame is cloned
// into the native worker; it remains retained until consumption is acknowledged.
class LocalAudioSink {
  constructor ({ port, sessionId, sourceIds, fault, ready = () => {} }) {
    Object.assign(this, { port, sourceIds, fault })
    this.credits = 0
    this.pending = null
    this.ending = null
    this.disposed = false
    this.ready = false
    port.on('message', ({ data }) => {
      if (this.disposed) return
      if (data?.type === 'credits') {
        if (!sourceIds.includes(data.sourceId) || data.count !== 1 ||
            ![0, 1].includes(data.consumed) || this.credits !== 0 ||
            (data.consumed === 0 && this.ready) ||
            (data.consumed === 1 && (!this.ready || !this.pending?.sent))) {
          this.fail()
          return
        }
        this.credits = 1
        if (!this.ready) { this.ready = true; ready() }
        if (data.consumed === 1) {
          const pending = this.pending
          this.pending = null
          pending.resolve()
        }
        this.sendPending()
      } else if (data?.type === 'end-received' && this.ending) {
        this.ending.resolve()
        this.ending = null
      }
    })
    port.on('close', () => { if (!this.disposed) this.fail() })
    port.start()
    port.postMessage({ type: 'ready', sessionId, sourceIds })
  }

  reanchor () {} // A freshly configured native worker has no preceding frames.

  ingestFrame (frame) {
    if (this.disposed || this.pending || this.ending) return Promise.reject(new Error('local port unavailable'))
    return new Promise((resolve, reject) => {
      this.pending = { frame, resolve, reject, sent: false }
      this.sendPending()
    })
  }

  sendPending () {
    if (!this.pending || this.pending.sent || !this.credits) return
    this.credits--
    this.pending.sent = true
    try { this.port.postMessage({ type: 'frame', ...this.pending.frame }) } catch { this.fail() }
  }

  flush () {
    if (this.disposed || this.pending) return Promise.reject(new Error('local port unavailable'))
    return new Promise((resolve, reject) => {
      this.ending = { resolve, reject }
      try { this.port.postMessage({ type: 'end' }) } catch { this.fail() }
    })
  }

  fail () {
    if (this.disposed) return
    this.dispose()
    this.fault('RECOGNITION_FALLBACK_FAILED')
  }

  dispose () {
    this.disposed = true
    this.pending?.reject(new Error('local port closed'))
    this.ending?.reject(new Error('local port closed'))
    this.pending = null
    this.ending = null
    try { this.port.close() } catch {}
  }
}

module.exports = { LocalAudioSink }
