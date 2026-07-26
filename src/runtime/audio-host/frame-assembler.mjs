/* 重采样输出 → 定长 PCM 帧。sequence 从 0 严格递增，timestampSeconds 由
   已产出样本数推导（单调、不受墙钟影响）。worklet 与测试共用同一实现。 */

export class FrameAssembler {
  constructor ({ frameSamples = 1600, sampleRate = 16000 } = {}) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) throw new TypeError('frameSamples must be a positive integer')
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new TypeError('sampleRate must be a positive integer')
    this.frameSamples = frameSamples
    this.sampleRate = sampleRate
    this.pending = []
    this.sequence = 0
    this.totalSamples = 0
  }

  append (samples) {
    for (let index = 0; index < samples.length; index += 1) this.pending.push(samples[index])
  }

  emit (flush) {
    const frames = []
    while (this.pending.length >= this.frameSamples || (flush && this.pending.length > 0)) {
      const length = Math.min(this.frameSamples, this.pending.length)
      const samples = Float32Array.from(this.pending.splice(0, length))
      frames.push({
        sequence: this.sequence,
        timestampSeconds: this.totalSamples / this.sampleRate,
        samples
      })
      this.sequence += 1
      this.totalSamples += samples.length
    }
    return frames
  }

  push (samples) {
    this.append(samples)
    return this.emit(false)
  }

  flush () {
    return this.emit(true)
  }
}
