'use strict'

const crypto = require('node:crypto')
const { NLS_PARAMETERS: PARAMETERS } = require('../../contracts/recognition')
const ENDPOINT = 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1'
function failure (code) { return Object.assign(new Error(code), { code }) }
function deferred () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => {}); return { promise, resolve, reject } }

class NlsRealtimeProvider {
  constructor ({ token, appKey, onResult = () => {}, onFault = () => {}, WebSocket = require('ws'), timeoutMs = 10000, heartbeatMs = 10000, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token) || typeof appKey !== 'string' || !appKey) throw failure('NLS_CONFIGURATION_REQUIRED')
    Object.assign(this, { token, appKey, onResult, onFault, WebSocket, timeoutMs, heartbeatMs, now, setTimer, clearTimer })
    this.taskId = crypto.randomBytes(16).toString('hex')
    this.state = 'idle'; this.outstanding = 0; this.nextSendAt = null; this.tail = Promise.resolve(); this.writes = new Set()
  }

  open ({ signal } = {}) {
    if (this.state !== 'idle') return Promise.reject(failure('NLS_CONNECTION_FAILED'))
    this.state = 'opening'; this.started = deferred()
    if (signal?.aborted) { this.fail('NLS_CANCELLED'); return this.started.promise }
    this.signal = signal
    this.onAbort = () => this.fail('NLS_CANCELLED')
    signal?.addEventListener('abort', this.onAbort, { once: true })
    this.deadline = setTimeout(() => this.fail('NLS_START_TIMEOUT'), this.timeoutMs)
    try {
      this.socket = new this.WebSocket(ENDPOINT, { headers: { 'X-NLS-Token': this.token }, followRedirects: false, maxPayload: 65536, perMessageDeflate: false, handshakeTimeout: this.timeoutMs })
      this.token = null
      this.socket.on('open', () => { if (this.state === 'opening') this.command('StartTranscription', PARAMETERS) })
      this.socket.on('message', (data, binary) => this.receive(data, binary))
      this.socket.on('error', () => this.fail('NLS_CONNECTION_FAILED'))
      this.socket.on('close', () => { if (!['closed', 'failed'].includes(this.state)) this.fail('NLS_CONNECTION_CLOSED') })
      this.socket.on('unexpected-response', (request, response) => { response.resume?.(); request.destroy?.(); this.fail('NLS_CONNECTION_FAILED') })
      this.socket.on('pong', () => { this.misses = 0 })
    } catch { this.fail('NLS_CONNECTION_FAILED') }
    return this.started.promise
  }

  command (name, payload) {
    try {
      this.socket.send(JSON.stringify({ header: { appkey: this.appKey, message_id: crypto.randomBytes(16).toString('hex'), task_id: this.taskId, namespace: 'SpeechTranscriber', name }, ...(payload ? { payload } : {}) }), error => { if (error) this.fail('NLS_CONNECTION_FAILED') })
    } catch { this.fail('NLS_CONNECTION_FAILED') }
  }

  receive (data, binary) {
    if (['closed', 'failed'].includes(this.state)) return
    try {
      if (binary || Buffer.byteLength(data) > 65536) throw new Error()
      const message = JSON.parse(data.toString())
      const h = message.header
      if (!h || h.task_id !== this.taskId || h.namespace !== 'SpeechTranscriber') throw new Error()
      if (h.status !== 20000000 || (message.payload?.status !== undefined && message.payload.status !== 0)) {
        this.fail(h.status === 40000001 ? 'NLS_AUTH_FAILED' : [40020105, 40020106].includes(h.status) ? 'NLS_PROJECT_INVALID' : 'NLS_SERVICE_FAILED'); return
      }
      if (h.name === 'TranscriptionStarted') {
        if (this.state !== 'opening') throw new Error()
        clearTimeout(this.deadline); this.state = 'active'; this.started.resolve()
        this.misses = 0
        this.heartbeat = setInterval(() => {
          if (this.misses >= 2) { this.fail('NLS_HEARTBEAT_TIMEOUT'); return }
          this.misses++
          try { this.socket.ping() } catch { this.fail('NLS_CONNECTION_FAILED') }
        }, this.heartbeatMs)
        return
      }
      if (h.name === 'TranscriptionCompleted') {
        if (this.state !== 'finishing' || !this.stopSent) throw new Error()
        this.state = 'closed'; this.cleanup(); this.completed.resolve(); this.socket.close(); return
      }
      if (!['active', 'finishing'].includes(this.state)) throw new Error()
      const kind = { SentenceBegin: 'begin', TranscriptionResultChanged: 'partial', SentenceEnd: 'final' }[h.name]
      if (!kind) throw new Error()
      const p = message.payload
      if (!p || !Number.isSafeInteger(p.index) || p.index < 1 || !Number.isSafeInteger(p.time) || p.time < 0) throw new Error()
      const beginMs = kind === 'begin' ? p.time : p.begin_time
      if (kind === 'final' && (!Number.isSafeInteger(beginMs) || beginMs < 0 || beginMs > p.time)) throw new Error()
      if (kind !== 'begin' && (typeof p.result !== 'string' || p.result.length > 32768)) throw new Error()
      this.onResult({ kind, index: p.index, beginMs: Number.isSafeInteger(beginMs) ? beginMs : undefined, timeMs: p.time, text: kind === 'begin' ? '' : p.result })
    } catch { this.fail('NLS_INVALID_RESPONSE') }
  }

  writeAudio (audio) {
    if (this.state !== 'active') return Promise.reject(failure('NLS_CONNECTION_CLOSED'))
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > 3200 || audio.byteLength % 2 !== 0) return Promise.reject(failure('NLS_INVALID_AUDIO'))
    if (Math.max(this.outstanding, this.socket.bufferedAmount || 0) + audio.byteLength > 64000) { this.fail('NLS_BUFFER_EXCEEDED'); return Promise.reject(failure('NLS_BUFFER_EXCEEDED')) }
    const copy = Buffer.from(audio)
    this.outstanding += copy.length
    const done = deferred()
    const item = { done, copy, timer: null }
    this.writes.add(item)
    const send = async () => {
      if (!['active', 'finishing'].includes(this.state)) throw failure('NLS_CONNECTION_CLOSED')
      const sendDeadline = this.nextSendAt === null ? this.now() : this.nextSendAt
      const waitMs = Math.max(0, sendDeadline - this.now())
      if (waitMs) await new Promise(resolve => { item.wake = resolve; item.timer = this.setTimer(resolve, waitMs) })
      if (!['active', 'finishing'].includes(this.state)) throw failure('NLS_CONNECTION_CLOSED')
      const frameDurationMs = copy.length / 32
      await new Promise((resolve, reject) => {
        item.rejectSend = reject
        try { this.socket.send(copy, { binary: true }, error => error ? reject(failure('NLS_CONNECTION_FAILED')) : resolve()) } catch { reject(failure('NLS_CONNECTION_FAILED')) }
      })
      const sentAt = this.now()
      // Preserve the audio-time schedule across small timer delays. If the
      // sender missed a complete frame interval, re-anchor once so queued
      // audio does not escape as an unbounded catch-up burst.
      this.nextSendAt = sentAt - sendDeadline >= frameDurationMs
        ? sentAt + frameDurationMs
        : sendDeadline + frameDurationMs
    }
    this.tail = this.tail.then(send).then(() => done.resolve(), error => { done.reject(error); this.fail(error.code || 'NLS_CONNECTION_FAILED') }).finally(() => { this.outstanding -= copy.length; copy.fill(0); this.writes.delete(item) })
    return done.promise
  }

  finishInput ({ signal } = {}) {
    if (this.completed) return this.completed.promise
    if (this.state !== 'active') return Promise.reject(failure('NLS_CONNECTION_CLOSED'))
    this.completed = deferred(); this.state = 'finishing'
    this.finishSignal = signal; this.finishAbort = () => this.fail('NLS_CANCELLED')
    signal?.addEventListener('abort', this.finishAbort, { once: true })
    if (signal?.aborted) { this.fail('NLS_CANCELLED'); return this.completed.promise }
    this.deadline = setTimeout(() => this.fail('NLS_STOP_TIMEOUT'), this.timeoutMs)
    this.tail.then(() => { if (this.state === 'finishing') { this.stopSent = true; this.command('StopTranscription') } })
    return this.completed.promise
  }

  cleanup () {
    clearTimeout(this.deadline); clearInterval(this.heartbeat)
    this.signal?.removeEventListener('abort', this.onAbort)
    this.finishSignal?.removeEventListener('abort', this.finishAbort)
    this.token = null
  }

  fail (code) {
    if (['closed', 'failed'].includes(this.state)) return
    const previous = this.state
    this.state = 'failed'; this.cleanup()
    const error = failure(code)
    this.started?.reject(error); this.completed?.reject(error)
    for (const item of this.writes) { this.clearTimer(item.timer); item.wake?.(); item.rejectSend?.(error); item.done.reject(error) }
    try { this.socket?.terminate() } catch {}
    if (previous === 'active') this.onFault(error)
  }

  abort () { this.fail('NLS_CANCELLED') }
}

module.exports = { NlsRealtimeProvider, ENDPOINT }
