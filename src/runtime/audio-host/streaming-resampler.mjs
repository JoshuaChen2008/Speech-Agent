/* 48k→16k 流式线性重采样与多声道下混。
   从 Gate 0C spike（scripts/gate-0c/streaming-resampler.mjs）原样提取；
   该实现已通过跨块相位连续性与三路实机采集验证。 */

export class StreamingLinearResampler {
  constructor (inputSampleRate, outputSampleRate) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) throw new TypeError('inputSampleRate must be positive')
    if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) throw new TypeError('outputSampleRate must be positive')
    this.ratio = inputSampleRate / outputSampleRate
    this.buffer = new Float32Array(0)
    this.position = 0
  }

  push (samples) {
    if (!(samples instanceof Float32Array)) throw new TypeError('samples must be a Float32Array')
    if (samples.length === 0) return new Float32Array(0)

    const combined = new Float32Array(this.buffer.length + samples.length)
    combined.set(this.buffer)
    combined.set(samples, this.buffer.length)
    this.buffer = combined

    const output = []
    while (this.position + 1 < this.buffer.length) {
      const left = Math.floor(this.position)
      const fraction = this.position - left
      output.push(this.buffer[left] + ((this.buffer[left + 1] - this.buffer[left]) * fraction))
      this.position += this.ratio
    }

    const consumed = Math.floor(this.position)
    if (consumed > 0) {
      const removed = Math.min(consumed, this.buffer.length)
      this.buffer = this.buffer.slice(removed)
      this.position -= removed
    }
    return Float32Array.from(output)
  }

  flush () {
    const output = []
    while (this.position < this.buffer.length) {
      const left = Math.floor(this.position)
      const right = Math.min(left + 1, this.buffer.length - 1)
      const fraction = this.position - left
      output.push(this.buffer[left] + ((this.buffer[right] - this.buffer[left]) * fraction))
      this.position += this.ratio
    }
    this.buffer = new Float32Array(0)
    this.position = 0
    return Float32Array.from(output)
  }
}

export function downmixToMono (channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0)
  const length = channels[0].length
  const mono = new Float32Array(length)
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length) throw new TypeError('channels must be equal-length Float32Arrays')
    for (let index = 0; index < length; index += 1) mono[index] += channel[index] / channels.length
  }
  return mono
}
