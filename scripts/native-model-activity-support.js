'use strict'

// @ts-check

/* Pure support code for the native model activity diagnostic. This module has
   no Electron dependency, so the WAV boundary and credit-controlled direct
   memory transport can be exercised in ordinary node:test CI. */

const SAMPLE_RATE = 16000
const DEFAULT_FRAME_SAMPLES = 1600

function parsePcm16MonoWav (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TypeError('fixture must be a RIFF/WAVE buffer')
  }

  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + chunkSize
    if (payloadEnd > buffer.length) throw new TypeError('fixture contains a truncated WAV chunk')
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new TypeError('fixture contains an invalid WAV format chunk')
      format = {
        audioFormat: buffer.readUInt16LE(payloadStart),
        channels: buffer.readUInt16LE(payloadStart + 2),
        sampleRate: buffer.readUInt32LE(payloadStart + 4),
        bitsPerSample: buffer.readUInt16LE(payloadStart + 14)
      }
    } else if (chunkId === 'data') {
      data = buffer.subarray(payloadStart, payloadEnd)
    }
    offset = payloadEnd + (chunkSize % 2)
  }

  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 ||
      format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== 16 || data.length % 2 !== 0) {
    throw new TypeError('fixture must be 16 kHz mono PCM16 WAV')
  }

  const samples = new Float32Array(data.length / 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32768
  }
  return Object.freeze({ sampleRate: format.sampleRate, samples })
}

class CreditControlledPcmSender {
  constructor (options) {
    if (!options || !options.port || typeof options.port.postMessage !== 'function') {
      throw new TypeError('a MessagePort-compatible port is required')
    }
    if (typeof options.sessionId !== 'string' || options.sessionId.length === 0 ||
        typeof options.sourceId !== 'string' || options.sourceId.length === 0) {
      throw new TypeError('sessionId and sourceId are required')
    }
    const creditTimeoutMs = options.creditTimeoutMs === undefined ? 30000 : options.creditTimeoutMs
    if (!Number.isInteger(creditTimeoutMs) || creditTimeoutMs < 1) {
      throw new TypeError('creditTimeoutMs must be a positive integer')
    }
    this.port = options.port
    this.sessionId = options.sessionId
    this.sourceId = options.sourceId
    this.creditTimeoutMs = creditTimeoutMs
    this.credits = 0
    this.waiters = []
    this.started = false
    this.closed = false
    this.handleMessage = (event) => this.onMessage(event)
    this.handleClose = () => this.close()
  }

  start () {
    if (this.started || this.closed) throw new Error('PCM sender cannot be started')
    this.started = true
    this.port.on('message', this.handleMessage)
    this.port.on('close', this.handleClose)
    this.port.start()
    this.port.postMessage({
      type: 'ready',
      sessionId: this.sessionId,
      sourceIds: [this.sourceId]
    })
  }

  onMessage (event) {
    const message = event && typeof event === 'object' && 'data' in event ? event.data : event
    if (message?.type !== 'credits' || message.sourceId !== this.sourceId ||
        !Number.isInteger(message.count) || message.count < 1) return
    this.credits += message.count
    this.releaseWaiters()
  }

  releaseWaiters () {
    while (this.credits > 0 && this.waiters.length > 0) {
      this.credits -= 1
      const waiter = this.waiters.shift()
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  takeCredit () {
    if (!this.started || this.closed) return Promise.reject(new Error('PCM sender is not active'))
    if (this.credits > 0) {
      this.credits -= 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('PCM credit timed out'))
      }, this.creditTimeoutMs)
      this.waiters.push(waiter)
    })
  }

  async sendFrame (frame) {
    if (!frame || !(frame.samples instanceof Float32Array) || frame.samples.length === 0 ||
        !Number.isInteger(frame.sequence) || frame.sequence < 0 ||
        !Number.isFinite(frame.timestampSeconds) || frame.timestampSeconds < 0) {
      throw new TypeError('invalid in-memory PCM frame')
    }
    await this.takeCredit()
    this.port.postMessage({
      type: 'frame',
      sourceId: this.sourceId,
      sequence: frame.sequence,
      timestampSeconds: frame.timestampSeconds,
      sampleCount: frame.samples.length,
      samples: frame.samples
    })
  }

  end () {
    if (!this.started || this.closed) throw new Error('PCM sender is not active')
    this.port.postMessage({ type: 'end' })
  }

  close () {
    if (this.closed) return
    this.closed = true
    if (typeof this.port.removeListener === 'function') {
      this.port.removeListener('message', this.handleMessage)
      this.port.removeListener('close', this.handleClose)
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('PCM sender closed'))
    }
    try { this.port.close() } catch { /* already closed */ }
  }
}

async function feedWaveInMemory (sender, samples, options = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('non-empty Float32Array fixture samples are required')
  }
  const frameSamples = options.frameSamples === undefined ? DEFAULT_FRAME_SAMPLES : options.frameSamples
  const trailingSilenceFrames = options.trailingSilenceFrames === undefined ? 15 : options.trailingSilenceFrames
  if (!Number.isInteger(frameSamples) || frameSamples < 1 ||
      !Number.isInteger(trailingSilenceFrames) || trailingSilenceFrames < 1) {
    throw new TypeError('frame and trailing silence sizes must be positive integers')
  }

  let sequence = 0
  let timestampSeconds = 0
  let samplesFed = 0
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const frame = samples.subarray(offset, Math.min(offset + frameSamples, samples.length))
    await sender.sendFrame({ sequence, timestampSeconds, samples: frame })
    sequence += 1
    samplesFed += frame.length
    timestampSeconds += frame.length / SAMPLE_RATE
  }
  const silence = new Float32Array(frameSamples)
  for (let index = 0; index < trailingSilenceFrames; index += 1) {
    await sender.sendFrame({ sequence, timestampSeconds, samples: silence })
    sequence += 1
    samplesFed += silence.length
    timestampSeconds += silence.length / SAMPLE_RATE
  }
  return Object.freeze({ framesFed: sequence, samplesFed, durationSeconds: timestampSeconds })
}

module.exports = {
  CreditControlledPcmSender,
  DEFAULT_FRAME_SAMPLES,
  SAMPLE_RATE,
  feedWaveInMemory,
  parsePcm16MonoWav
}
