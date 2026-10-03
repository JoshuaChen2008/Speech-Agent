'use strict'

// SEM-F12/F14, J20: diagnostic only. Synthetic PCM stays in bounded memory.
// Network and timer scheduling are controlled; product modules are unmodified.
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { NlsRealtimeProvider } = require('../src/runtime/recognition/nls-realtime-provider')
const { CloudAudioBuffer } = require('../src/runtime/recognition/cloud-audio-buffer')
const { RecognitionSessionRouter } = require('../src/runtime/recognition/recognition-session-router')
const turn = () => new Promise(setImmediate)

async function measure ({ stallMs = 0, counterfactual = false, unfinished = false }) {
  let clock = 0; let socket; let bytes = 0; let finalCount = 0; let partialCount = 0
  let peakPendingMs = 0; let peakRetainedMs = 0
  const timers = []; const faults = []
  let buffer
  const fault = code => faults.push({ code, elapsedMs: clock })
  const router = new RecognitionSessionRouter({ sessionId: 'synthetic', sourceId: 'loopback',
    now: () => clock, status: () => {},
    emit: event => { if (event.kind === 'final') finalCount++; else partialCount++ },
    control: message => { if (message.type === 'begin') buffer.begin(message.sample); else if (message.type === 'commit') buffer.commit(message.sample) }
  })
  const generation = router.openStream(0)
  class Socket extends EventEmitter {
    constructor () { super(); socket = this; this.bufferedAmount = 0 }
    send (data, options, callback) {
      if (Buffer.isBuffer(data)) {
        const startMs = bytes / 32
        const index = unfinished ? 1 : Math.floor(startMs / 1000) + 1
        const beginMs = unfinished ? 0 : (index - 1) * 1000
        if (startMs === beginMs) this.result('SentenceBegin', { index, time: beginMs })
        bytes += data.length
        this.result(!unfinished && bytes % 32000 === 0 ? 'SentenceEnd' : 'TranscriptionResultChanged',
          { index, begin_time: beginMs, time: bytes / 32, result: 'synthetic' })
      }
      const done = typeof options === 'function' ? options : callback
      if (Buffer.isBuffer(data) && stallMs && bytes % 320000 === 0) {
        timers.push({ at: clock + stallMs, callback: () => done?.() })
      } else done?.()
    }
    result (name, payload) {
      this.emit('message', Buffer.from(JSON.stringify({ header: { task_id: provider.taskId,
        namespace: 'SpeechTranscriber', status: 20000000, name }, payload })), false)
    }
    ping () { this.emit('pong') }
    terminate () {}
  }
  const provider = new NlsRealtimeProvider({ token: 'synthetic', appKey: 'synthetic', WebSocket: Socket,
    now: () => clock, onResult: result => router.result(generation, result), onFault: error => fault(error.code),
    setTimer: (callback, delay) => {
      const due = clock + delay
      const timer = { at: counterfactual ? clock : due, callback }
      timers.push(timer); return timer
    },
    clearTimer: timer => { if (timer) timer.cancelled = true }
  })
  buffer = new CloudAudioBuffer({ core: null, emit: () => {}, fault,
    send: frame => {
      router.audio(frame.startSample, frame.sampleCount)
      provider.writeAudio(frame.pcm).then(() => buffer.acknowledge(frame.id), () => {})
    }
  })
  async function advance (target) {
    for (;;) {
      await turn()
      timers.sort((a, b) => a.at - b.at)
      while (timers[0]?.cancelled) timers.shift()
      if (!timers.length || timers[0].at > target) break
      const timer = timers.shift(); clock = Math.max(clock, timer.at); timer.callback()
    }
    clock = Math.max(clock, target); await turn()
  }
  try {
    const opening = provider.open(); socket.emit('open'); socket.result('TranscriptionStarted'); await opening
    for (let sequence = 0; sequence < 1800 && !faults.length; sequence++) {
      await advance((sequence + 1) * 100)
      buffer.ingestFrame({ sequence, timestampSeconds: sequence / 10,
        sampleCount: 1600, samples: new Float32Array(1600) })
      peakPendingMs = Math.max(peakPendingMs, buffer.pendingSamples / 16)
      peakRetainedMs = Math.max(peakRetainedMs, buffer.queuedSamples / 16)
      await turn()
    }
    if (!faults.length) await advance(clock + 3000)
    return { stallMs, counterfactual, unfinished, finalCount, partialCount,
      peakPendingMs, peakRetainedMs, faults: faults.slice() }
  } finally { provider.abort(); buffer.dispose(); await provider.tail }
}

async function main () {
  const scenarios = []
  for (const options of [{}, { stallMs: 150 }, { stallMs: 150, counterfactual: true }, { unfinished: true }]) {
    scenarios.push(await measure(options))
  }
  const hashes = {}
  for (const name of ['nls-realtime-provider', 'cloud-audio-buffer', 'recognition-session-router']) {
    hashes[name] = createHash('sha256').update(readFileSync(require.resolve('../src/runtime/recognition/' + name))).digest('hex')
  }
  console.log(JSON.stringify({ kind: 'diagnostic-only', hashes, scenarios }))
  if (process.argv.includes('--assert-continuity') && scenarios.some(value =>
    value.faults.length || value.finalCount + value.partialCount !== 1800 || value.peakRetainedMs > 60000)) process.exitCode = 1
}
main().catch(() => { console.error('NLS_INTERRUPTION_DIAGNOSTIC_FAILED'); process.exitCode = 2 })
