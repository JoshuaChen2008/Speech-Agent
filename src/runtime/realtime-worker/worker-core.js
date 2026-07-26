'use strict'

// @ts-check

/* realtime worker 的纯逻辑核心（B2.3）。
   --------------------------------------------------------------------------
   每个 sourceId 一条独立管线：帧 → VAD 分段 → recognizer adapter →
   contract-valid CaptionEvent（partial/final）。职责边界：
   - 只组装事件，不广播：事件的唯一去向是主进程 SessionCoordinator 的
     acceptCaption 路径（sequence 按 session+source 严格递增、revision 按
     segment 严格递增、segmentId 含 sourceId 保证跨源唯一）。
   - adapter 不产文本（Null）时只累计分段/指标，绝不发无文本事件。
   - 段前缓冲：VAD 确认 speech-start 需要 N 帧，确认前的 voiced 帧先入
     预备缓冲，开段时一并喂给 adapter，避免吃掉句首。
   进程接线（端口、credit、parentPort）在 realtime-worker.js。 */

const { EnergyVad } = require('./energy-vad')
const { createRecognizerAdapter } = require('./recognizer-adapter')

const SAMPLE_RATE = 16000

class SourcePipeline {
  constructor (options) {
    this.sessionId = options.sessionId
    this.sourceId = options.sourceId
    this.adapter = options.adapter
    this.vad = options.vad
    this.preRollLimit = options.preRollLimit === undefined ? 4 : options.preRollLimit
    this.sequence = 0
    this.segmentOrdinal = 0
    this.segment = null
    this.preRoll = []
    this.expectedFrameSequence = null
    this.metricsState = {
      framesIngested: 0,
      sequenceGapCount: 0,
      missedFrames: 0,
      segmentsDetected: 0,
      forcedSegmentEnds: 0,
      captionsEmitted: 0,
      peakRms: 0
    }
  }

  frameEndSeconds (frame) {
    return frame.timestampSeconds + (frame.sampleCount / SAMPLE_RATE)
  }

  emit (kind, text, t1) {
    this.sequence += 1
    this.segment.revision += 1
    this.metricsState.captionsEmitted += 1
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      segmentId: this.segment.id,
      sequence: this.sequence,
      revision: this.segment.revision,
      kind,
      t0: this.segment.t0,
      /* 夹逼防契约违约：生产端时间戳回退（如采集重启）时 t1 不得小于 t0，
         否则事件在 host 边界被静默丢弃、整段字幕消失。 */
      t1: Math.max(t1, this.segment.t0),
      text,
      translation: null
    }
  }

  /**
   * @param {{ sequence: number, timestampSeconds: number, sampleCount: number, samples: Float32Array }} frame
   * @returns {*[]} 产生的 CaptionEvent（可能为空）
   */
  ingestFrame (frame) {
    this.metricsState.framesIngested += 1
    if (this.expectedFrameSequence !== null && frame.sequence > this.expectedFrameSequence) {
      this.metricsState.sequenceGapCount += 1
      this.metricsState.missedFrames += frame.sequence - this.expectedFrameSequence
    }
    this.expectedFrameSequence = frame.sequence + 1

    const events = []
    const verdict = this.vad.push(frame.samples)
    if (verdict.rms > this.metricsState.peakRms) {
      this.metricsState.peakRms = Number(verdict.rms.toFixed(6))
    }

    if (!this.segment) {
      if (verdict.event === 'speech-start') {
        this.segmentOrdinal += 1
        this.metricsState.segmentsDetected += 1
        const opening = [...this.preRoll, frame]
        this.preRoll = []
        this.segment = {
          id: `seg-${this.sourceId}-${this.segmentOrdinal}`,
          revision: 0,
          t0: opening[0].timestampSeconds,
          lastText: null
        }
        for (const buffered of opening) {
          this.adapter.acceptFrame(buffered.samples, buffered.timestampSeconds)
        }
        this.maybeEmitPartial(events, this.frameEndSeconds(frame))
      } else if (verdict.voiced) {
        /* VAD 确认前的 voiced 帧：入段前缓冲，开段时补喂。 */
        this.preRoll.push(frame)
        if (this.preRoll.length > this.preRollLimit) this.preRoll.shift()
      } else {
        this.preRoll = []
      }
      return events
    }

    this.adapter.acceptFrame(frame.samples, frame.timestampSeconds)
    if (verdict.event === 'speech-end') {
      if (verdict.forced) this.metricsState.forcedSegmentEnds += 1
      const finalText = this.adapter.endSegment()
      /* 契约的非空判定用 trim：纯空白 final 会在 host 边界被拒，这里同标准。 */
      if (typeof finalText === 'string' && finalText.trim().length > 0) {
        events.push(this.emit('final', finalText, this.frameEndSeconds(frame)))
      }
      this.segment = null
      return events
    }
    this.maybeEmitPartial(events, this.frameEndSeconds(frame))
    return events
  }

  maybeEmitPartial (events, t1) {
    const text = this.adapter.poll()
    if (typeof text !== 'string' || text.length === 0) return
    if (text === this.segment.lastText) return
    this.segment.lastText = text
    events.push(this.emit('partial', text, t1))
  }

  /** 会话停止：未收束的段走 adapter.endSegment 定稿（有文本才发）。 */
  flush (timestampSeconds) {
    const events = []
    if (this.segment) {
      const finalText = this.adapter.endSegment()
      if (typeof finalText === 'string' && finalText.trim().length > 0) {
        events.push(this.emit('final', finalText, Math.max(timestampSeconds, this.segment.t0)))
      }
      this.segment = null
    }
    this.vad.reset()
    this.preRoll = []
    return events
  }

  metrics () {
    return { ...this.metricsState, inSegment: !!this.segment }
  }

  dispose () {
    try { this.adapter.dispose() } catch { /* best effort */ }
  }
}

class WorkerCore {
  /**
   * @param {{
   *   sessionId: string,
   *   sourceIds: string[],
   *   recognizerProfile?: string,
   *   vadOptions?: *,
   *   adapterFactory?: (sourceId: string) => *,
   *   preRollLimit?: number
   * }} options
   */
  constructor (options) {
    if (!options || typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TypeError('sessionId is required')
    }
    if (!Array.isArray(options.sourceIds) || options.sourceIds.length === 0) {
      throw new TypeError('sourceIds are required')
    }
    const profile = options.recognizerProfile === undefined ? 'null' : options.recognizerProfile
    const adapterFactory = options.adapterFactory || (() => createRecognizerAdapter(profile))
    this.sources = new Map()
    for (const sourceId of options.sourceIds) {
      if (this.sources.has(sourceId)) throw new TypeError(`duplicate sourceId: ${sourceId}`)
      this.sources.set(sourceId, new SourcePipeline({
        sessionId: options.sessionId,
        sourceId,
        adapter: adapterFactory(sourceId),
        vad: new EnergyVad(options.vadOptions),
        preRollLimit: options.preRollLimit
      }))
    }
  }

  /** @returns {*[]} 该帧产生的 CaptionEvent */
  ingestFrame (frame) {
    const pipeline = this.sources.get(frame?.sourceId)
    if (!pipeline) return []
    if (!Number.isInteger(frame.sequence) || frame.sequence < 0) return []
    if (!Number.isInteger(frame.sampleCount) || frame.sampleCount <= 0) return []
    if (!Number.isFinite(frame.timestampSeconds) || frame.timestampSeconds < 0) return []
    if (!(frame.samples instanceof Float32Array)) return []
    return pipeline.ingestFrame(frame)
  }

  flush (timestampSeconds = 0) {
    const events = []
    for (const pipeline of this.sources.values()) events.push(...pipeline.flush(timestampSeconds))
    return events
  }

  metrics () {
    const sources = {}
    for (const [sourceId, pipeline] of this.sources) sources[sourceId] = pipeline.metrics()
    return sources
  }

  dispose () {
    for (const pipeline of this.sources.values()) pipeline.dispose()
    this.sources.clear()
  }
}

module.exports = { SAMPLE_RATE, SourcePipeline, WorkerCore }
