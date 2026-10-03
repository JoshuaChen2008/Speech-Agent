'use strict'

// SEM-F12/F14, J20 diagnostic only: synthetic in-memory PCM, no network/files.
// The timer bypass is a counterfactual experiment, never a production policy.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { NlsRealtimeProvider } = require('../src/runtime/recognition/nls-realtime-provider')
const { CloudAudioBuffer } = require('../src/runtime/recognition/cloud-audio-buffer')
const { RecognitionSessionRouter } = require('../src/runtime/recognition/recognition-session-router')
const turn = () => new Promise(setImmediate)

async function measure ({ deliveryStallMs, bypassTimer = false }) {
  let clock = 0
  let socket
  let bytes = 0
  let peakPendingSamples = 0
  const timers = []
  const observations = []
  const writes = []
  const faults = []
  const router = new RecognitionSessionRouter({
    sessionId: 'synthetic', sourceId: 'loopback', control: () => {}, status: () => {},
    emit: event => observations.push({ audioEndMs: Math.round(event.t1 * 1000), delayMs: clock - Math.round(event.t1 * 1000) })
  })
  const generation = router.openStream(0)
  class Socket extends EventEmitter {
    constructor () { super(); socket = this; this.bufferedAmount = 0 }
    send (data, options, callback) {
      if (Buffer.isBuffer(data)) {
        if (!bytes) this.result('SentenceBegin', { index: 1, time: 0 })
        bytes += data.byteLength
        this.result('TranscriptionResultChanged', { index: 1, time: bytes / 32, result: 'synthetic' })
      }
      ;(typeof options === 'function' ? options : callback)?.()
    }
    result (name, payload) {
      this.emit('message', Buffer.from(JSON.stringify({ header: {
        task_id: provider.taskId, namespace: 'SpeechTranscriber', status: 20000000, name
      }, payload })), false)
    }
    terminate () {}
    ping () {}
  }
  const provider = new NlsRealtimeProvider({
    token: 'synthetic', appKey: 'synthetic', WebSocket: Socket,
    now: () => clock,
    setTimer: (callback, delay) => {
      const timer = { at: clock + (bypassTimer ? 0 : delay), callback }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => { if (timer) timer.cancelled = true },
    onResult: result => router.result(generation, result),
    onFault: error => faults.push(error.code)
  })
  const buffer = new CloudAudioBuffer({
    core: null, emit: () => {}, fault: code => faults.push(code),
    send: frame => {
      router.audio(frame.startSample, frame.sampleCount)
      writes.push(provider.writeAudio(frame.pcm).then(() => buffer.acknowledge(frame.id)))
    }
  })
  async function advance (target) {
    for (;;) {
      await turn()
      timers.sort((a, b) => a.at - b.at)
      const next = timers.find(timer => !timer.cancelled && timer.at <= target)
      if (!next) break
      next.cancelled = true
      clock = Math.max(clock, next.at)
      next.callback()
    }
    clock = Math.max(clock, target)
    await turn()
  }
  try {
    const opening = provider.open()
    socket.emit('open')
    socket.result('TranscriptionStarted')
    await opening
    for (let end = 100; end <= 5000; end += 100) {
      // Frames captured between 1000ms and stall end arrive together, then
      // delivery returns to 100ms cadence. The recognizer boundary is instant.
      const delivery = end >= 1000 && end <= 1000 + deliveryStallMs ? 1000 + deliveryStallMs : end
      await advance(delivery)
      buffer.ingestFrame({ sequence: end / 100 - 1, timestampSeconds: (end - 100) / 1000,
        sampleCount: 1600, samples: new Float32Array(1600) })
      peakPendingSamples = Math.max(peakPendingSamples, buffer.pendingSamples)
      await turn()
    }
    await advance(7000)
    await Promise.all(writes)
    await provider.tail
    assert.deepEqual(faults, [])
    assert.equal(observations.length, 50)
    assert.equal(buffer.pendingSamples, 0)
    assert.equal(provider.outstanding, 0)
    const steady = observations.filter(item => item.audioEndMs >= 3000).map(item => item.delayMs)
    return { deliveryStallMs, bypassTimer, partialCount: observations.length,
      steadyDelayMinMs: Math.min(...steady), steadyDelayMaxMs: Math.max(...steady),
      peakPendingMs: peakPendingSamples / 16, faultCount: faults.length }
  } finally { provider.abort(); buffer.dispose() }
}

async function main () {
  const scenarios = []
  for (const deliveryStallMs of [0, 300, 600, 1200]) scenarios.push(await measure({ deliveryStallMs }))
  scenarios.push(await measure({ deliveryStallMs: 600, bypassTimer: true }))
  console.log(JSON.stringify({ kind: 'diagnostic-only', providerSha256: createHash('sha256')
    .update(readFileSync(require.resolve('../src/runtime/recognition/nls-realtime-provider'))).digest('hex'), scenarios }))
  if (process.argv.includes('--assert-recovery')) {
    // Diagnostic sensitivity threshold, NOT an I2 acceptance threshold.
    const recovered = scenarios.filter(item => !item.bypassTimer).every(item => item.steadyDelayMaxMs <= 200)
    if (!recovered) process.exitCode = 1
  }
}
if (require.main === module) main().catch(() => { console.error('NLS_PACING_DIAGNOSTIC_FAILED'); process.exitCode = 2 })
