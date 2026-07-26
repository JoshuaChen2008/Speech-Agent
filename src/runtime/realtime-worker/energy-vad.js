'use strict'

// @ts-check

/* 能量阈值 VAD（B2.3 占位实现）。
   接口与未来的 silero VAD 对齐：逐帧输入，返回 speech-start / speech-end
   边界事件；连续 voiced 帧数达到阈值才开段（防瞬态误触发），连续静音帧数
   达到阈值才收段（hangover），超长段强制收段兜底（v1 分段由 VAD speech-end
   主导，recognizer endpoint 只兜底——见 PLAN §5.3）。
   纯逻辑：不做重采样、不碰模型。真实产品 VAD 由模型轨引入 silero 后替换，
   本实现保留用于结构测试。 */

class EnergyVad {
  constructor (options = {}) {
    this.threshold = options.threshold === undefined ? 0.01 : options.threshold
    this.voicedFramesToStart = options.voicedFramesToStart === undefined ? 2 : options.voicedFramesToStart
    this.silentFramesToEnd = options.silentFramesToEnd === undefined ? 5 : options.silentFramesToEnd
    this.maxSegmentFrames = options.maxSegmentFrames === undefined ? 300 : options.maxSegmentFrames
    if (!(this.threshold > 0)) throw new TypeError('threshold must be positive')
    for (const key of ['voicedFramesToStart', 'silentFramesToEnd', 'maxSegmentFrames']) {
      if (!Number.isInteger(this[key]) || this[key] <= 0) throw new TypeError(`${key} must be a positive integer`)
    }
    this.inSpeech = false
    this.voicedStreak = 0
    this.silentStreak = 0
    this.segmentFrames = 0
  }

  rms (samples) {
    if (samples.length === 0) return 0
    let sum = 0
    for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
    return Math.sqrt(sum / samples.length)
  }

  /**
   * @param {Float32Array} samples 一帧 16k mono PCM
   * @returns {{ event: 'speech-start' | 'speech-end' | null, voiced: boolean, forced: boolean, rms: number }}
   */
  push (samples) {
    const rms = this.rms(samples)
    const voiced = rms >= this.threshold
    if (!this.inSpeech) {
      this.voicedStreak = voiced ? this.voicedStreak + 1 : 0
      if (this.voicedStreak >= this.voicedFramesToStart) {
        this.inSpeech = true
        this.voicedStreak = 0
        this.silentStreak = 0
        /* 本帧计入段内：确认所需的前导 voiced 帧由调用方的段前缓冲补回。 */
        this.segmentFrames = 1
        return { event: 'speech-start', voiced, forced: false, rms }
      }
      return { event: null, voiced, forced: false, rms }
    }

    this.segmentFrames += 1
    this.silentStreak = voiced ? 0 : this.silentStreak + 1
    if (this.silentStreak >= this.silentFramesToEnd) {
      this.reset()
      return { event: 'speech-end', voiced, forced: false, rms }
    }
    if (this.segmentFrames >= this.maxSegmentFrames) {
      this.reset()
      return { event: 'speech-end', voiced, forced: true, rms }
    }
    return { event: null, voiced, forced: false, rms }
  }

  reset () {
    this.inSpeech = false
    this.voicedStreak = 0
    this.silentStreak = 0
    this.segmentFrames = 0
  }
}

module.exports = { EnergyVad }
