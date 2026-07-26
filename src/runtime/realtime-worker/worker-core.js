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
    /* B3：段定稿后把整段音频交给精修请求方（realtime-worker 决定是否发给
       refine worker）。null = 不保留段音频（结构模式零额外内存）。 */
    this.onSegmentFinalized = options.onSegmentFinalized || null
    /* 恢复游标（B2.0 契约）：replacement worker 的 sequence 从游标续增，
       segmentId 以 attempt 命名空间隔离，旧游标才不会拒绝新事件。 */
    this.sequence = options.sequenceBase || 0
    this.segmentPrefix = options.attempt > 0 ? `seg-a${options.attempt}` : 'seg'
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
      refinedEmitted: 0,
      peakRms: 0
    }
  }

  /** 段收束的共同出口：发 final（有文本才发）并上交段音频。 */
  finalizeSegment (events, t1) {
    const segment = this.segment
    this.segment = null
    const finalText = this.adapter.endSegment()
    if (typeof finalText !== 'string' || finalText.trim().length === 0) return
    events.push(this.emitFor(segment, 'final', finalText, t1))
    if (this.onSegmentFinalized && segment.chunks.length > 0) {
      const info = {
        sourceId: this.sourceId,
        segmentId: segment.id,
        baseRevision: segment.revision,
        t0: segment.t0,
        t1: Math.max(t1, segment.t0),
        chunks: segment.chunks
      }
      segment.chunks = []
      try { this.onSegmentFinalized(info) } catch { /* requester failures stay isolated */ }
    }
  }

  frameEndSeconds (frame) {
    return frame.timestampSeconds + (frame.sampleCount / SAMPLE_RATE)
  }

  emitFor (segment, kind, text, t1) {
    this.sequence += 1
    segment.revision += 1
    this.metricsState.captionsEmitted += 1
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      segmentId: segment.id,
      sequence: this.sequence,
      revision: segment.revision,
      kind,
      t0: segment.t0,
      /* 夹逼防契约违约：生产端时间戳回退（如采集重启）时 t1 不得小于 t0，
         否则事件在 host 边界被静默丢弃、整段字幕消失。 */
      t1: Math.max(t1, segment.t0),
      text,
      translation: null
    }
  }

  emit (kind, text, t1) {
    return this.emitFor(this.segment, kind, text, t1)
  }

  /** 精修结果的脱段发射：段已收束，sequence 继续从本管线权威分配，
      revision 严格接在 final 之后——coordinator 的单调校验因此天然通过。 */
  emitRefined (info, text) {
    this.sequence += 1
    this.metricsState.captionsEmitted += 1
    this.metricsState.refinedEmitted += 1
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      segmentId: info.segmentId,
      sequence: this.sequence,
      revision: info.baseRevision + 1,
      kind: 'refined',
      t0: info.t0,
      t1: Math.max(info.t1, info.t0),
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
          /* segmentId 用【开段时的续增 sequence】而非本地 ordinal：sequence 从
             恢复游标续增，跨 worker 世代天然唯一——fault-retry（同 adapter、
             attempt 不变）fork 的新 worker 不会与上一代的 segmentId 冲突，
             已定稿段永远不可能被新段回改（§12.3 回归的关闭点）。 */
          id: `${this.segmentPrefix}-${this.sourceId}-${this.sequence + 1}`,
          revision: 0,
          t0: opening[0].timestampSeconds,
          lastText: null,
          /* 精修需要整段音频；无请求方时不保留（结构模式零额外内存）。
             上限随段而弃：段最长 30s ≈ 1.92MB。 */
          chunks: []
        }
        for (const buffered of opening) {
          this.adapter.acceptFrame(buffered.samples, buffered.timestampSeconds)
          if (this.onSegmentFinalized) this.segment.chunks.push(buffered.samples)
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
    if (this.onSegmentFinalized) this.segment.chunks.push(frame.samples)
    if (verdict.event === 'speech-end') {
      if (verdict.forced) this.metricsState.forcedSegmentEnds += 1
      this.finalizeSegment(events, this.frameEndSeconds(frame))
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
      this.finalizeSegment(events, Math.max(timestampSeconds, this.segment.t0))
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
   *   vadFactory?: (sourceId: string) => *,
   *   adapterFactory?: (sourceId: string) => *,
   *   preRollLimit?: number,
   *   onSegmentFinalized?: (info: *) => void
   * }} options
   */
  constructor (options) {
    if (!options || typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TypeError('sessionId is required')
    }
    if (!Array.isArray(options.sourceIds) || options.sourceIds.length === 0) {
      throw new TypeError('sourceIds are required')
    }
    const attempt = options.attempt === undefined ? 0 : options.attempt
    if (!Number.isInteger(attempt) || attempt < 0) throw new TypeError('attempt must be a non-negative integer')
    const sequenceBases = options.sequenceBases || {}
    if (typeof sequenceBases !== 'object' || Array.isArray(sequenceBases)) {
      throw new TypeError('sequenceBases must be an object')
    }
    const profile = options.recognizerProfile === undefined ? 'null' : options.recognizerProfile
    const adapterFactory = options.adapterFactory || (() => createRecognizerAdapter(profile))
    /* VAD 可注入（silero 真实实现经 vadFactory 进来）；默认保持 EnergyVad
       —— 结构测试与无 VAD 模型时的诚实降级路径。 */
    const vadFactory = options.vadFactory || (() => new EnergyVad(options.vadOptions))
    this.sources = new Map()
    for (const sourceId of options.sourceIds) {
      if (this.sources.has(sourceId)) throw new TypeError(`duplicate sourceId: ${sourceId}`)
      const sequenceBase = sequenceBases[sourceId] || 0
      if (!Number.isInteger(sequenceBase) || sequenceBase < 0) {
        throw new TypeError(`sequenceBases.${sourceId} must be a non-negative integer`)
      }
      this.sources.set(sourceId, new SourcePipeline({
        sessionId: options.sessionId,
        sourceId,
        adapter: adapterFactory(sourceId),
        vad: vadFactory(sourceId),
        preRollLimit: options.preRollLimit,
        onSegmentFinalized: options.onSegmentFinalized,
        attempt,
        sequenceBase
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

  /** 暂停恢复后重新锚定帧序号：暂停期跳过的帧不算传输缺口（哨兵指标不被污染）。 */
  reanchor () {
    for (const pipeline of this.sources.values()) pipeline.expectedFrameSequence = null
  }

  /** 精修结果发射（sequence/revision 由对应管线权威分配）；未知 source 返回 null。 */
  emitRefined (info, text) {
    const pipeline = this.sources.get(info?.sourceId)
    if (!pipeline || typeof text !== 'string' || text.length === 0) return null
    return pipeline.emitRefined(info, text)
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
