'use strict'

// Worker-owned PCM. No credentials, network, filesystem or provider JSON.
const RATE = 16000
const RETAIN_SAMPLES = RATE * 60
const SEND_SAMPLES = RATE * 2

class CloudAudioBuffer {
  constructor ({ core = null, send, emit, fault, progress = () => {}, schedule = setImmediate }) {
    this.core = core
    this.send = send
    this.emit = emit
    this.fault = fault
    this.progress = progress
    this.schedule = schedule
    this.frames = []
    this.pending = new Map()
    this.pendingSamples = 0
    this.queuedSamples = 0
    this.endSample = 0
    this.expectedSequence = 0
    this.activeBegin = null
    this.cloud = true
    this.failed = false
    this.ended = false
    this.draining = false
    this.localActive = false
    this.localPhase = null
    this.waiters = []
  }

  fail (code) {
    if (this.failed) return
    this.failed = true
    this.core?.dispose?.()
    this.release()
    this.fault(code)
  }

  ingestFrame (frame) {
    if (this.failed || this.ended) return []
    const start = Math.round(frame.timestampSeconds * RATE)
    if (!(frame.samples instanceof Float32Array) || frame.sampleCount !== frame.samples.length ||
        frame.sampleCount < 1 || frame.sampleCount > 1600 || start !== this.endSample ||
        frame.sequence !== this.expectedSequence || !frame.samples.every(Number.isFinite)) {
      this.fail('RECOGNITION_AUDIO_GAP')
      return []
    }
    this.expectedSequence += 1
    this.endSample += frame.sampleCount
    this.frames.push(frame)
    this.queuedSamples += frame.sampleCount
    if (!this.cloud) {
      if (this.queuedSamples > RETAIN_SAMPLES) this.fail('RECOGNITION_BUFFER_LIMIT')
      else this.drain()
      return []
    }
    while (this.queuedSamples > RETAIN_SAMPLES && this.frames.length) {
      // Retention is only for local handoff, not cloud transcription.
      // A long cloud segment must not pin PCM indefinitely. takeover()
      // still rejects a cut that has left the retained window.
      const first = this.frames.shift()
      this.queuedSamples -= first.sampleCount
    }
    if (this.pendingSamples + frame.sampleCount > SEND_SAMPLES) {
      this.fail('RECOGNITION_BUFFER_LIMIT')
      return []
    }
    const pcm = new Uint8Array(frame.sampleCount * 2)
    const view = new DataView(pcm.buffer)
    for (let i = 0; i < frame.sampleCount; i++) {
      const sample = Math.max(-1, Math.min(1, frame.samples[i]))
      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
    }
    this.pending.set(frame.sequence, frame.sampleCount)
    this.pendingSamples += frame.sampleCount
    try { this.send({ type: 'audio', id: frame.sequence, startSample: start, sampleCount: frame.sampleCount, pcm }) } catch {
      this.fail('RECOGNITION_AUDIO_GAP')
    }
    return []
  }

  acknowledge (id) {
    const count = this.pending.get(id)
    if (count === undefined) return
    this.pending.delete(id)
    this.pendingSamples -= count
  }

  begin (sample) {
    if (!this.cloud || this.failed) return
    if (!Number.isInteger(sample) || sample < this.firstSample() || sample > this.endSample) {
      this.fail('RECOGNITION_AUDIO_GAP')
      return
    }
    this.activeBegin = sample
  }

  commit (sample) {
    if (!this.cloud || this.failed) return
    if (!Number.isInteger(sample) || sample < 0 || sample > this.endSample) {
      this.fail('NLS_INVALID_RESPONSE')
      return
    }
    this.activeBegin = null
    while (this.frames.length) {
      const frame = this.frames[0]
      if (Math.round(frame.timestampSeconds * RATE) + frame.sampleCount > sample) break
      this.frames.shift()
      this.queuedSamples -= frame.sampleCount
    }
  }

  firstSample () {
    return this.frames.length ? Math.round(this.frames[0].timestampSeconds * RATE) : this.endSample
  }

  takeover (sample) {
    if (!this.cloud || this.failed) return
    if (this.ended) { this.fail('RECOGNITION_FALLBACK_FAILED'); return }
    if (!Number.isInteger(sample) || sample < this.firstSample() || sample > this.endSample) {
      this.fail('RECOGNITION_AUDIO_GAP')
      return
    }
    this.commit(sample)
    const first = this.frames[0]
    if (first) {
      const skip = sample - Math.round(first.timestampSeconds * RATE)
      if (skip > 0) {
        first.samples = first.samples.slice(skip)
        first.sampleCount -= skip
        first.timestampSeconds = sample / RATE
        this.queuedSamples -= skip
      }
    }
    this.cloud = false
    this.pending.clear()
    this.pendingSamples = 0
    // No native work is done here. Capture continues while another process
    // loads the models, and the frozen cut must never roll out of retention.
    if (this.core) this.startLocal()
  }

  attachLocal (core) {
    if (this.cloud || this.failed || this.ended || this.core) { core.dispose(); return false }
    this.core = core
    return true
  }

  startLocal () {
    if (this.cloud || this.failed || this.ended || !this.core || this.localActive) return false
    this.localActive = true
    this.core.reanchor()
    this.localPhase = 'replaying'
    this.progress(this.localPhase)
    this.drain()
    return true
  }

  drain () {
    if (this.draining || this.failed || this.cloud || !this.localActive) return
    this.draining = true
    this.schedule(async () => {
      if (this.failed) { this.draining = false; return }
      try {
        // Keep in-flight samples inside the bound until the native worker ACKs.
        for (let i = 0; i < 2 && this.frames.length; i++) {
          const frame = this.frames[0]
          const events = await this.core.ingestFrame(frame)
          if (this.failed) break
          for (const event of events || []) this.emit(event)
          this.frames.shift()
          this.queuedSamples -= frame.sampleCount
        }
        this.draining = false
        if (this.failed) return
        if (this.frames.length) this.drain()
        else {
          if (this.localPhase !== 'local') { this.localPhase = 'local'; this.progress(this.localPhase) }
          this.resolveWaiters()
        }
      } catch { this.draining = false; this.fail('RECOGNITION_FALLBACK_FAILED') }
    })
  }

  async end () {
    this.ended = true
    if (!this.cloud && !this.localActive) { this.dispose(); return }
    if (!this.cloud && !this.failed && (this.draining || this.frames.length)) {
      await new Promise(resolve => this.waiters.push(resolve))
    }
    if (!this.cloud && !this.failed) {
      try { for (const event of (await this.core.flush(this.endSample / RATE)) || []) this.emit(event) } catch {
        this.fail('RECOGNITION_FALLBACK_FAILED')
      }
    }
  }

  resolveWaiters () { for (const resolve of this.waiters.splice(0)) resolve() }
  release () {
    this.frames = []
    this.pending.clear()
    this.pendingSamples = 0
    this.queuedSamples = 0
    this.resolveWaiters()
  }
  dispose () { this.failed = true; this.core?.dispose?.(); this.release() }
}

module.exports = { CloudAudioBuffer, RATE, RETAIN_SAMPLES, SEND_SAMPLES }
