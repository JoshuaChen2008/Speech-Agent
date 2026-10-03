'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { NlsRealtimeProvider, ENDPOINT } = require('../../src/runtime/recognition/nls-realtime-provider')
class Socket extends EventEmitter {
  constructor (url, options) { super(); this.url = url; this.options = options; this.sent = []; this.bufferedAmount = 0; Socket.last = this }
  send (data, options, callback) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : Buffer.from(data)); (typeof options === 'function' ? options : callback)?.() }
  close () { this.emit('close') }
  terminate () { this.terminated = true; this.emit('close') }
  ping () { this.pings = (this.pings || 0) + 1 }
  message (provider, name, payload, extra = {}) { this.emit('message', Buffer.from(JSON.stringify({ header: { task_id: provider.taskId, namespace: 'SpeechTranscriber', status: 20000000, name, ...extra }, payload })), false) }
}
async function open (t, options = {}) {
  const results = []; const faults = []
  const provider = new NlsRealtimeProvider({ token: 'synthetic-token', appKey: 'synthetic-project', WebSocket: Socket, onResult: r => results.push(r), onFault: e => faults.push(e.code), ...options })
  t.after(() => provider.abort())
  const ready = provider.open(); const socket = Socket.last
  socket.emit('open'); socket.message(provider, 'TranscriptionStarted'); await ready
  return { provider, socket, results, faults }
}
test('SEM-F25 J20 NLS header auth, fixed parameters, partial/final and stop tail preserve protocol order', async t => {
  const { provider, socket, results } = await open(t)
  assert.equal(socket.url, ENDPOINT); assert.equal(socket.url.includes('token'), false)
  assert.equal(socket.options.headers['X-NLS-Token'], 'synthetic-token')
  assert.equal(socket.options.followRedirects, false)
  assert.equal(socket.sent[0].payload.sample_rate, 16000)
  await provider.writeAudio(new Uint8Array(3200))
  socket.message(provider, 'SentenceBegin', { index: 1, time: 0 })
  socket.message(provider, 'TranscriptionResultChanged', { index: 1, time: 100, result: 'synthetic partial' })
  const done = provider.finishInput(); assert.equal(provider.finishInput(), done)
  await new Promise(setImmediate)
  socket.message(provider, 'SentenceEnd', { index: 1, begin_time: 0, time: 100, result: 'synthetic stable', status: 0 })
  socket.message(provider, 'TranscriptionCompleted')
  await done
  assert.deepEqual(results.map(r => r.kind), ['begin', 'partial', 'final'])
  assert.equal(socket.sent.filter(s => s.header?.name === 'StopTranscription').length, 1)
})
test('SEM-F25 J20 startup rejection does not signal runtime fallback; active close reports once', async t => {
  const faults = []
  const provider = new NlsRealtimeProvider({ token: 't', appKey: 'p', WebSocket: Socket, onFault: e => faults.push(e.code) })
  const start = provider.open(); Socket.last.emit('error', new Error('raw private details'))
  await assert.rejects(start, { code: 'NLS_CONNECTION_FAILED' }); assert.deepEqual(faults, [])
  const active = await open(t)
  active.socket.emit('close'); active.socket.emit('error', new Error('raw'))
  assert.deepEqual(active.faults, ['NLS_CONNECTION_CLOSED'])
})

test('SEM-F25 J20 zero PCM before started; NLS authentication and project errors remain distinct', async () => {
  for (const [status, code] of [[40000001, 'NLS_AUTH_FAILED'], [40020105, 'NLS_PROJECT_INVALID'], [40020106, 'NLS_PROJECT_INVALID']]) {
    const provider = new NlsRealtimeProvider({ token: 't', appKey: 'p', WebSocket: Socket })
    const start = provider.open(); const socket = Socket.last
    socket.emit('open')
    await assert.rejects(provider.writeAudio(new Uint8Array(3200)), { code: 'NLS_CONNECTION_CLOSED' })
    assert.equal(socket.sent.some(Buffer.isBuffer), false)
    socket.message(provider, 'TaskFailed', undefined, { status })
    await assert.rejects(start, { code })
  }
})
test('SEM-F25 J20 invalid task, service payload status and oversized messages fail closed', async t => {
  for (const variant of ['task', 'status', 'size']) {
    const { provider, socket, faults } = await open(t)
    if (variant === 'size') socket.emit('message', Buffer.alloc(65537), false)
    else socket.message(provider, 'SentenceBegin', { index: 1, time: 0, ...(variant === 'status' ? { status: 1 } : {}) }, variant === 'task' ? { task_id: 'different-task' } : {})
    assert.deepEqual(faults, [variant === 'status' ? 'NLS_SERVICE_FAILED' : 'NLS_INVALID_RESPONSE'])
  }
})
test('SEM-F25 J20 stop timeout rejects without runtime fallback and releases queued PCM', async t => {
  const { provider, faults } = await open(t, { timeoutMs: 15 })
  await assert.rejects(provider.finishInput(), { code: 'NLS_STOP_TIMEOUT' })
  assert.deepEqual(faults, [])
})
test('SEM-F12/J20 cumulative PCM pacing catches up after a stall with a bounded send interval', async t => {
  const clock = { now: 0, timers: [], sentAt: [] }
  class TimedSocket extends Socket {
    send (data, options, callback) {
      if (Buffer.isBuffer(data)) clock.sentAt.push(clock.now)
      super.send(data, options, callback)
    }
  }
  const { provider } = await open(t, {
    WebSocket: TimedSocket,
    now: () => clock.now,
    setTimer: (callback, delay) => {
      const timer = { at: clock.now + delay + (clock.timers.length === 0 ? 350 : 10), callback }
      clock.timers.push(timer)
      return timer
    },
    clearTimer: timer => { if (timer) timer.cancelled = true }
  })

  await provider.writeAudio(new Uint8Array(3200))
  const second = provider.writeAudio(new Uint8Array(3200))
  const third = provider.writeAudio(new Uint8Array(3200))
  await new Promise(setImmediate)
  assert.equal(clock.timers[0].at, 450)

  clock.now = clock.timers[0].at
  clock.timers[0].callback()
  await second
  await new Promise(setImmediate)
  assert.deepEqual(clock.sentAt, [0, 450])
  assert.equal(clock.timers[1].at, 540)

  clock.now = clock.timers[1].at
  clock.timers[1].callback()
  await third
  assert.deepEqual(clock.sentAt, [0, 450, 540])
})

test('SEM-F25 J20 bounded queued PCM rejects overflow, while silence alone is not a fault', async t => {
  const { provider, socket, faults } = await open(t)
  const writes = Array.from({ length: 21 }, () => provider.writeAudio(new Uint8Array(3200)))
  const result = await Promise.allSettled(writes)
  assert.equal(result[20].reason.code, 'NLS_BUFFER_EXCEEDED')
  assert.deepEqual(faults, ['NLS_BUFFER_EXCEEDED'])
  await provider.tail
  assert.equal(provider.outstanding, 0)
  assert.equal(socket.terminated, true)
  const healthy = await open(t, { heartbeatMs: 5 })
  const timer = setInterval(() => healthy.socket.emit('pong'), 3)
  await new Promise(r => setTimeout(r, 30)); clearInterval(timer)
  assert.deepEqual(healthy.faults, [])
})
test('SEM-F25 J20 two missed heartbeats trigger a single bounded failure', async t => {
  let fault
  const occurred = new Promise(resolve => { fault = resolve })
  const { provider } = await open(t, { heartbeatMs: 5, onFault: fault })
  const error = await occurred
  const faults = [error.code]
  assert.deepEqual(faults, ['NLS_HEARTBEAT_TIMEOUT'])
  assert.equal(provider.state, 'failed')
})
