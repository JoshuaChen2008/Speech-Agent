import { downmixToMono, StreamingLinearResampler } from './streaming-resampler.mjs'

class Gate0CPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000
    this.frameSamples = options.processorOptions?.frameSamples || 1600
    this.resampler = new StreamingLinearResampler(sampleRate, this.targetSampleRate)
    this.pending = []
    this.sequence = 0
    this.totalSamples = 0
    this.active = true
    this.port.onmessage = (event) => {
      if (event.data?.type === 'stop') {
        this.append(this.resampler.flush())
        this.emitFrames(true)
        this.active = false
        this.port.postMessage({
          type: 'stopped',
          totalSamples: this.totalSamples,
          inputSampleRate: sampleRate,
          outputSampleRate: this.targetSampleRate
        })
      }
    }
  }

  append (samples) {
    for (let index = 0; index < samples.length; index += 1) this.pending.push(samples[index])
  }

  emitFrames (flush = false) {
    while (this.pending.length >= this.frameSamples || (flush && this.pending.length > 0)) {
      const length = Math.min(this.frameSamples, this.pending.length)
      const frame = Float32Array.from(this.pending.splice(0, length))
      const message = {
        type: 'frame',
        sequence: this.sequence,
        timestampSeconds: this.totalSamples / this.targetSampleRate,
        samples: frame
      }
      this.sequence += 1
      this.totalSamples += frame.length
      this.port.postMessage(message, [frame.buffer])
    }
  }

  process (inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0)
    if (!this.active) return false

    const channels = inputs[0] || []
    if (channels.length === 0 || channels[0].length === 0) return true
    const mono = downmixToMono(channels)
    this.append(this.resampler.push(mono))
    this.emitFrames(false)
    return true
  }
}

registerProcessor('gate-0c-pcm-capture', Gate0CPcmCaptureProcessor)
