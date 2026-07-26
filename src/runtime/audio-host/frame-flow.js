'use strict'

// @ts-check

/* PCM 帧的 credit 背压与有界队列（B2.2）。
   --------------------------------------------------------------------------
   MessagePort 本身没有背压信号：消费端（realtime worker）通过控制消息授予
   credit，生产端（audio host renderer）每发一帧消耗一个 credit。credit 用尽
   说明消费跟不上实时——帧进入按毫秒预算限界的队列，超出预算丢弃最旧帧
   （保新弃旧：字幕要的是「现在」，延迟不能无限增长）。丢帧通过 sequence
   缺口对消费端可见，并计入指标。

   纯逻辑，不碰 MessagePort。UMD：renderer 直接 <script> 引入，测试 require。 */

;(function (root) {
  class FrameFlow {
    /**
     * @param {{
     *   send: (frame: *) => void,   实际传输调用（postMessage 包装）
     *   sampleRate?: number,
     *   maxQueueMs?: number,        队列毫秒预算，超出丢最旧
     *   initialCredits?: number
     * }} options
     */
    constructor (options) {
      if (!options || typeof options.send !== 'function') throw new TypeError('send function is required')
      this.send = options.send
      this.sampleRate = options.sampleRate || 16000
      this.maxQueueMs = options.maxQueueMs === undefined ? 2000 : options.maxQueueMs
      if (!Number.isFinite(this.maxQueueMs) || this.maxQueueMs <= 0) throw new TypeError('maxQueueMs must be positive')
      this.credits = options.initialCredits || 0
      this.queue = []
      this.queuedMs = 0
      this.metricsState = {
        capturedFrames: 0,
        sentFrames: 0,
        droppedFrames: 0,
        creditStalls: 0,
        maxQueuedMsObserved: 0,
        /* 已确认或已核销的帧数：消费端 credits 消息的 consumed 字段累计，
           加上端口替换时被核销（视同处理完毕）的未确认帧。 */
        acknowledgedFrames: 0,
        /* 端口替换时「已发送但从未被确认」的帧数上界——发进死端口的帧
           不产生 sequence 缺口也不进 droppedFrames，只能在这里可观测。 */
        lostInFlightFrames: 0,
        portReplacements: 0
      }
    }

    frameMs (frame) {
      return (frame.sampleCount / this.sampleRate) * 1000
    }

    /** 采集到一帧。返回本次被丢弃的帧数。 */
    handleFrame (frame) {
      if (!Number.isInteger(frame?.sampleCount) || frame.sampleCount <= 0) {
        throw new TypeError('frame.sampleCount must be a positive integer')
      }
      this.metricsState.capturedFrames += 1
      if (this.credits > 0 && this.queue.length === 0) {
        this.credits -= 1
        this.metricsState.sentFrames += 1
        this.send(frame)
        return 0
      }
      if (this.credits === 0) this.metricsState.creditStalls += 1
      this.queue.push(frame)
      this.queuedMs += this.frameMs(frame)
      let dropped = 0
      while (this.queuedMs > this.maxQueueMs && this.queue.length > 1) {
        const oldest = this.queue.shift()
        this.queuedMs -= this.frameMs(oldest)
        this.metricsState.droppedFrames += 1
        dropped += 1
      }
      this.metricsState.maxQueuedMsObserved = Math.max(this.metricsState.maxQueuedMsObserved, this.queuedMs)
      this.drain()
      return dropped
    }

    /** 消费端授信。 */
    grantCredits (count) {
      if (!Number.isInteger(count) || count <= 0) throw new TypeError('credits must be a positive integer')
      this.credits += count
      this.drain()
    }

    /** 消费端确认消费（credits 消息附带的 consumed 计数）。 */
    acknowledge (count) {
      if (!Number.isInteger(count) || count <= 0) return
      this.metricsState.acknowledgedFrames = Math.min(
        this.metricsState.sentFrames,
        this.metricsState.acknowledgedFrames + count
      )
    }

    /**
     * 端口被替换：旧消费端的授信作废；已发送但未确认的帧计入
     * lostInFlightFrames（上界——旧消费端可能已消费但没来得及确认）。
     * 队列保留，等新消费端重新授信。
     */
    markPortReplaced () {
      this.credits = 0
      this.metricsState.lostInFlightFrames += this.metricsState.sentFrames - this.metricsState.acknowledgedFrames
      this.metricsState.acknowledgedFrames = this.metricsState.sentFrames
      this.metricsState.portReplacements += 1
    }

    drain () {
      while (this.credits > 0 && this.queue.length > 0) {
        const frame = this.queue.shift()
        this.queuedMs -= this.frameMs(frame)
        this.credits -= 1
        this.metricsState.sentFrames += 1
        this.send(frame)
      }
      if (this.queue.length === 0) this.queuedMs = 0
    }

    /** 丢弃队列中未发送的帧（stop/track-ended 时调用）。返回丢弃数。 */
    discardQueued () {
      const discarded = this.queue.length
      this.metricsState.droppedFrames += discarded
      this.queue = []
      this.queuedMs = 0
      return discarded
    }

    metrics () {
      return {
        ...this.metricsState,
        queuedFrames: this.queue.length,
        queuedMs: Number(this.queuedMs.toFixed(3)),
        credits: this.credits
      }
    }
  }

  const api = { FrameFlow }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.FrameFlowModule = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
