/* AudioWorklet：原生采样率多声道 → 16kHz mono Float32 定长帧。
   拓扑与消息协议继承 Gate 0C 验证版本；帧组装抽到 FrameAssembler 以便单测。 */

import { downmixToMono, StreamingLinearResampler } from './streaming-resampler.mjs'
import { FrameAssembler } from './frame-assembler.mjs'

class LiveSubtitlePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()
    const targetSampleRate = options.processorOptions?.targetSampleRate || 16000
    const frameSamples = options.processorOptions?.frameSamples || 1600
    this.resampler = new StreamingLinearResampler(sampleRate, targetSampleRate)
    this.assembler = new FrameAssembler({ frameSamples, sampleRate: targetSampleRate })
    this.targetSampleRate = targetSampleRate
    this.active = true
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'stop') return
      this.postFrames(this.assembler.push(this.resampler.flush()))
      this.postFrames(this.assembler.flush())
      this.active = false
      this.port.postMessage({
        type: 'stopped',
        totalSamples: this.assembler.totalSamples,
        inputSampleRate: sampleRate,
        outputSampleRate: this.targetSampleRate
      })
    }
  }

  postFrames (frames) {
    for (const frame of frames) {
      this.port.postMessage({
        type: 'frame',
        sequence: frame.sequence,
        timestampSeconds: frame.timestampSeconds,
        samples: frame.samples
      }, [frame.samples.buffer])
    }
  }

  process (inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0)
    if (!this.active) return false

    const channels = inputs[0] || []
    if (channels.length === 0 || channels[0].length === 0) return true
    this.postFrames(this.assembler.push(this.resampler.push(downmixToMono(channels))))
    return true
  }
}

registerProcessor('live-subtitle-pcm-capture', LiveSubtitlePcmCaptureProcessor)
