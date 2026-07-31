'use strict'

// @ts-check

/* Streaming copy of the frozen Gate 0B speech-onset rule.
   --------------------------------------------------------------------------
   The probe observes PCM in memory and records only timing scalars. It never
   exposes, encodes, or persists samples. Speech onset is the first of two
   consecutive 20 ms windows whose RMS is at least -45 dBFS.

   UMD keeps the implementation shared by the sandboxed audio-host renderer
   and Node tests without granting the renderer filesystem/module access. */

;(function (root) {
  const DEFAULT_SAMPLE_RATE = 16000
  const DEFAULT_WINDOW_MS = 20
  const DEFAULT_THRESHOLD_DBFS = -45
  const DEFAULT_CONSECUTIVE_WINDOWS = 2

  function finiteNumber (value, label) {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`)
    return value
  }

  class SpeechOnsetProbe {
    constructor (options = {}) {
      this.sampleRate = options.sampleRate === undefined ? DEFAULT_SAMPLE_RATE : options.sampleRate
      this.windowMs = options.windowMs === undefined ? DEFAULT_WINDOW_MS : options.windowMs
      this.thresholdDbfs = options.thresholdDbfs === undefined ? DEFAULT_THRESHOLD_DBFS : options.thresholdDbfs
      this.consecutiveWindows = options.consecutiveWindows === undefined
        ? DEFAULT_CONSECUTIVE_WINDOWS
        : options.consecutiveWindows
      if (!Number.isInteger(this.sampleRate) || this.sampleRate <= 0) {
        throw new TypeError('sampleRate must be a positive integer')
      }
      if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
        throw new TypeError('windowMs must be positive')
      }
      if (!Number.isFinite(this.thresholdDbfs) || this.thresholdDbfs >= 0) {
        throw new TypeError('thresholdDbfs must be a finite negative number')
      }
      if (!Number.isInteger(this.consecutiveWindows) || this.consecutiveWindows <= 0) {
        throw new TypeError('consecutiveWindows must be a positive integer')
      }
      this.windowSamples = Math.max(1, Math.round(this.sampleRate * this.windowMs / 1000))
      this.threshold = 10 ** (this.thresholdDbfs / 20)
      /* The renderer's performance.now() timeline. This is deliberately
         process-local: cross-process conversion belongs to the controller's
         NTP-style calibration, never to this PCM-only probe. */
      this.armedAtClockMs = null
      this.audioFloorTimestampSeconds = null
      this.windowSampleCount = 0
      this.windowEnergy = 0
      this.windowValid = true
      this.windowStartTimestampSeconds = null
      this.expectedNextSampleIndex = null
      this.lastSequence = null
      this.aboveThresholdWindows = 0
      this.runStartTimestampSeconds = null
      this.detection = null
      this.discontinuityCount = 0
      this.invalidSampleCount = 0
    }

    arm (armedAtClockMs, audioFloorTimestampSeconds = null) {
      this.armedAtClockMs = finiteNumber(armedAtClockMs, 'armedAtClockMs')
      if (audioFloorTimestampSeconds !== null) {
        finiteNumber(audioFloorTimestampSeconds, 'audioFloorTimestampSeconds')
        if (audioFloorTimestampSeconds < 0) throw new TypeError('audioFloorTimestampSeconds must not be negative')
      }
      this.audioFloorTimestampSeconds = audioFloorTimestampSeconds
      this.resetWindowRun()
      this.expectedNextSampleIndex = null
      this.lastSequence = null
      this.detection = null
      this.discontinuityCount = 0
      this.invalidSampleCount = 0
    }

    resetWindowRun () {
      this.windowSampleCount = 0
      this.windowEnergy = 0
      this.windowValid = true
      this.windowStartTimestampSeconds = null
      this.aboveThresholdWindows = 0
      this.runStartTimestampSeconds = null
    }

    /**
     * @param {{samples: Float32Array, timestampSeconds: number, sequence: number, ingressClockMs: number}} frame
     * @returns {null | {onsetAudioTimestampMs: number, observedAtClockMs: number, detectionFrameSequence: number}}
     */
    observeFrame (frame) {
      if (this.armedAtClockMs === null || this.detection) return null
      if (!(frame?.samples instanceof Float32Array) || frame.samples.length === 0) {
        throw new TypeError('frame.samples must be a non-empty Float32Array')
      }
      if (!Number.isInteger(frame.sequence) || frame.sequence < 0) {
        throw new TypeError('frame.sequence must be a non-negative integer')
      }
      const timestampSeconds = finiteNumber(frame.timestampSeconds, 'frame.timestampSeconds')
      const ingressClockMs = finiteNumber(frame.ingressClockMs, 'frame.ingressClockMs')
      if (timestampSeconds < 0) throw new TypeError('frame.timestampSeconds must not be negative')

      /* A timestamp discontinuity means windows on opposite sides cannot form
         the required consecutive pair. Reset only the probe window state; the
         capture and ASR streams continue independently. */
      const startSampleIndex = Math.round(timestampSeconds * this.sampleRate)
      const sequenceGap = this.lastSequence !== null && frame.sequence !== this.lastSequence + 1
      const timestampGap = this.expectedNextSampleIndex !== null && startSampleIndex !== this.expectedNextSampleIndex
      if (sequenceGap || timestampGap) {
        this.resetWindowRun()
        this.discontinuityCount += 1
      }
      this.lastSequence = frame.sequence
      this.expectedNextSampleIndex = startSampleIndex + frame.samples.length

      let startIndex = 0
      if (this.audioFloorTimestampSeconds !== null && timestampSeconds < this.audioFloorTimestampSeconds) {
        startIndex = Math.min(
          frame.samples.length,
          Math.max(0, Math.ceil((this.audioFloorTimestampSeconds - timestampSeconds) * this.sampleRate))
        )
      }
      for (let index = startIndex; index < frame.samples.length; index += 1) {
        const value = frame.samples[index]
        if (!Number.isFinite(value)) {
          this.invalidSampleCount += 1
          this.windowValid = false
        }
        if (this.windowSampleCount === 0) {
          this.windowStartTimestampSeconds = timestampSeconds + (index / this.sampleRate)
        }
        if (Number.isFinite(value)) this.windowEnergy += value * value
        this.windowSampleCount += 1
        if (this.windowSampleCount !== this.windowSamples) continue

        const above = this.windowValid &&
          Math.sqrt(this.windowEnergy / this.windowSamples) >= this.threshold
        if (above) {
          if (this.aboveThresholdWindows === 0) this.runStartTimestampSeconds = this.windowStartTimestampSeconds
          this.aboveThresholdWindows += 1
        } else {
          this.aboveThresholdWindows = 0
          this.runStartTimestampSeconds = null
        }
        this.windowSampleCount = 0
        this.windowEnergy = 0
        this.windowValid = true
        this.windowStartTimestampSeconds = null
        if (this.aboveThresholdWindows >= this.consecutiveWindows) {
          const onsetSeconds = this.runStartTimestampSeconds
          this.detection = Object.freeze({
            onsetAudioTimestampMs: Number((Math.max(0, onsetSeconds) * 1000).toFixed(3)),
            observedAtClockMs: Math.round(ingressClockMs),
            detectionFrameSequence: frame.sequence
          })
          return this.detection
        }
      }
      return null
    }

    snapshot (streamClockEstimateMs) {
      const anchor = Number.isFinite(streamClockEstimateMs) ? streamClockEstimateMs : null
      const estimated = this.detection && anchor !== null
        ? Math.round(anchor + this.detection.onsetAudioTimestampMs)
        : null
      return Object.freeze({
        armedAtClockMs: this.armedAtClockMs === null ? null : Math.round(this.armedAtClockMs),
        clockAnchorClockMs: anchor === null ? null : Math.round(anchor),
        speechOnsetAudioTimestampMs: this.detection?.onsetAudioTimestampMs ?? null,
        speechOnsetEstimatedClockMs: estimated,
        speechOnsetObservedClockMs: this.detection?.observedAtClockMs ?? null,
        speechOnsetFrameSequence: this.detection?.detectionFrameSequence ?? null,
        discontinuityCount: this.discontinuityCount,
        invalidSampleCount: this.invalidSampleCount
      })
    }
  }

  const api = {
    DEFAULT_CONSECUTIVE_WINDOWS,
    DEFAULT_SAMPLE_RATE,
    DEFAULT_THRESHOLD_DBFS,
    DEFAULT_WINDOW_MS,
    SpeechOnsetProbe
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SpeechOnsetProbeModule = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
