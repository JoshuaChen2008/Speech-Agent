'use strict'

// @ts-check

/* silero VAD（真实人声检测，替换 EnergyVad 占位）。
   --------------------------------------------------------------------------
   与 EnergyVad 同接口（push(samples) → {event, voiced, forced, rms}、
   reset()），worker-core 经 vadFactory 注入,不感知实现差异。

   映射：sherpa-onnx 的 Vad.isDetected() 是「当前是否处于人声中」的状态量，
   本包装把它的翻转映射为 speech-start / speech-end 事件。要点：

   - isDetected 的置位滞后真实说话起点约 0.3-0.5s（minSpeechDuration +
     窗口粒度）；句首音频由 worker-core 的段前缓冲补偿——因此 voiced 字段
     不来自 silero（它没有逐帧概率输出），而是一个极低门限（0.004 RMS）的
     能量启发式，只用于「哪些帧值得进段前缓冲」，不参与分段判定。静音帧
     会清空缓冲，上一句的尾音不会串进下一段。
   - 段收束由 silero 的 minSilenceDuration 决定（默认 0.5s 静音定稿）；
     超长段与 EnergyVad 同样由包装层强制收束兜底（maxSegmentFrames）。
     强制收束后 isDetected 仍为真时，下一帧立即开新段（连续长话自然续段）。
   - silero 内部的分段队列（front/pop）与音频环形缓冲不参与识别路径
     （识别器直接吃原始帧），每次 push 顺手排空防积压。
   - 实测（2026-07-27，本仓库 models/vad/silero_vad.onnx，SHA256
     9e2449e1...1fd6）：受控语料 5 段边界与真实停顿吻合；997Hz 纯音 3s
     不被判为人声——这正是能量占位实现做不到的。

   构造需要 sherpa-onnx-node（原生模块）：只应在 configure 携带 vad 选项时
   被 require；测试可注入 nativeVad 替身验证纯逻辑。 */

const SAMPLE_RATE = 16000
/** 段前缓冲启发式门限：远低于语音 RMS，高于数字静音。 */
const PRE_ROLL_RMS = 0.004

function assertSileroVadOptions (options) {
  if (!options || typeof options !== 'object') throw new TypeError('vad options are required')
  if (options.kind !== 'silero') throw new TypeError(`unsupported vad kind: ${String(options.kind)}`)
  if (typeof options.modelPath !== 'string' || options.modelPath.length === 0) {
    throw new TypeError('vad modelPath is required')
  }
  const withDefault = (key, fallback) => {
    const value = options[key]
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`vad ${key} must be a positive number`)
    return value
  }
  const maxSegmentFrames = options.maxSegmentFrames === undefined ? 300 : options.maxSegmentFrames
  if (!Number.isInteger(maxSegmentFrames) || maxSegmentFrames <= 0) {
    throw new TypeError('vad maxSegmentFrames must be a positive integer')
  }
  return Object.freeze({
    kind: 'silero',
    modelPath: options.modelPath,
    threshold: withDefault('threshold', 0.5),
    /* 收句静音 1.0s（非 sherpa 默认 0.5s），实测定的：流式模型对过短的段
       缺右上下文——受控语料在 0.5s 切段时丢字（「一下」→「一」）且几乎
       不出标点，0.8s 仍丢字，1.0s 桥接 0.7-0.9s 的词间停顿后整句成段、
       CER 0。代价是定稿在停顿 1s 后出现（partial 不受影响）。 */
    minSilenceDuration: withDefault('minSilenceDuration', 1.0),
    minSpeechDuration: withDefault('minSpeechDuration', 0.25),
    windowSize: withDefault('windowSize', 512),
    maxSegmentFrames
  })
}

function createNativeVad (options) {
  const sherpa = require('sherpa-onnx-node')
  return new sherpa.Vad({
    sileroVad: {
      model: options.modelPath,
      threshold: options.threshold,
      minSilenceDuration: options.minSilenceDuration,
      minSpeechDuration: options.minSpeechDuration,
      windowSize: options.windowSize
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  }, 30)
}

class SileroVad {
  /**
   * @param {*} rawOptions {kind:'silero', modelPath, ...}
   * @param {*} [nativeVad] 测试注入用；省略时按选项创建 sherpa Vad
   */
  constructor (rawOptions, nativeVad) {
    const options = assertSileroVadOptions(rawOptions)
    this.maxSegmentFrames = options.maxSegmentFrames
    /* WorkerCore may pre-feed only this VAD's energy-gated candidate frames
       into the recognizer. Silero remains the sole authority that opens a
       segment or permits a caption to leave the worker. */
    this.provisionalRecognizerFeed = true
    this.vad = nativeVad || createNativeVad(options)
    this.inSpeech = false
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
    const voiced = rms >= PRE_ROLL_RMS
    this.vad.acceptWaveform(samples)
    /* 分段队列只排空，不消费：识别路径吃原始帧。 */
    while (!this.vad.isEmpty()) this.vad.pop()
    const detected = this.vad.isDetected()

    if (!this.inSpeech) {
      if (detected) {
        this.inSpeech = true
        this.segmentFrames = 1
        return { event: 'speech-start', voiced, forced: false, rms }
      }
      return { event: null, voiced, forced: false, rms }
    }

    this.segmentFrames += 1
    if (!detected) {
      this.inSpeech = false
      this.segmentFrames = 0
      return { event: 'speech-end', voiced, forced: false, rms }
    }
    if (this.segmentFrames >= this.maxSegmentFrames) {
      /* 兜底强制收束；silero 仍在人声中,下一帧立即开新段。 */
      this.inSpeech = false
      this.segmentFrames = 0
      return { event: 'speech-end', voiced, forced: true, rms }
    }
    return { event: null, voiced, forced: false, rms }
  }

  reset () {
    this.inSpeech = false
    this.segmentFrames = 0
    try { this.vad.reset() } catch { /* native teardown races are non-fatal */ }
  }
}

module.exports = { PRE_ROLL_RMS, SileroVad, assertSileroVadOptions }
