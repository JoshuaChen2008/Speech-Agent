'use strict'

// @ts-check

/* PCM 诊断指标与 WAV 落盘。编码/解析与 Gate 0C 的实测实现一致；
   诊断判定与 Gate 0C 的区别：产品诊断不放挑战音，静音是合法状态
   （系统可能就是没声音），只对「管线完整性」与「数据损坏」判失败，
   电平只报告不判定。 */

const crypto = require('node:crypto')

function encodePcm16Wav (samples, sampleRate = 16000) {
  if (!(samples instanceof Float32Array)) throw new TypeError('samples must be a Float32Array')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new TypeError('sampleRate must be a positive integer')
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    buffer.writeInt16LE(value, 44 + (index * 2))
  }
  return buffer
}

function parsePcm16Wav (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('WAV is too short')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid RIFF/WAVE header')

  let format = null
  let data = null
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) throw new Error(`Truncated ${id} chunk`)
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid fmt chunk')
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      }
    } else if (id === 'data') {
      data = buffer.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (!format || !data) throw new Error('WAV requires fmt and data chunks')
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) throw new Error('Expected mono PCM16 WAV')
  if (data.length % 2 !== 0) throw new Error('PCM16 data size must be even')

  const samples = new Float32Array(data.length / 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = data.readInt16LE(index * 2) / 32768
  return { ...format, dataBytes: data.length, sampleCount: samples.length, samples }
}

function sha256 (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function dbfs (value) {
  return value > 0 ? 20 * Math.log10(value) : -240
}

/** 电平与损坏统计。只统计，不判定——判定在 evaluateDiagnostic。 */
function analyzeLevels (samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new TypeError('non-empty Float32Array required')
  let peak = 0
  let sum = 0
  let clippingCount = 0
  let overRangeCount = 0
  let nonFiniteCount = 0
  let longestFullScaleRun = 0
  let fullScaleRun = 0
  let nonSilentCount = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    if (!Number.isFinite(value)) { nonFiniteCount += 1; continue }
    const absolute = Math.abs(value)
    peak = Math.max(peak, absolute)
    sum += value * value
    if (absolute > 1) overRangeCount += 1
    if (absolute >= 0.999) {
      clippingCount += 1
      fullScaleRun += 1
      longestFullScaleRun = Math.max(longestFullScaleRun, fullScaleRun)
    } else fullScaleRun = 0
    if (absolute >= 0.0005) nonSilentCount += 1
  }
  const overallRms = Math.sqrt(sum / samples.length)
  const round = (value) => Number(value.toFixed(6))
  return {
    sampleCount: samples.length,
    peak: round(peak),
    rms: round(overallRms),
    rmsDbfs: round(dbfs(overallRms)),
    nonSilentRatio: round(nonSilentCount / samples.length),
    clippingCount,
    clippedRatio: round(clippingCount / samples.length),
    longestFullScaleRun,
    overRangeCount,
    nonFiniteCount,
    signalObserved: nonSilentCount / samples.length > 0.01
  }
}

/**
 * 诊断判定。
 * @param {*} pipeline host renderer 上报的帧管线指标
 * @param {*} levels analyzeLevels 的输出
 * @param {number} durationMs 请求的采集时长
 */
function evaluateDiagnostic (pipeline, levels, durationMs) {
  const capturedSeconds = pipeline.sampleCount / pipeline.outputSampleRate
  const clockCoverageRatio = pipeline.wallElapsedSeconds > 0 ? capturedSeconds / pipeline.wallElapsedSeconds : 0
  const durationCoverageRatio = capturedSeconds / (durationMs / 1000)
  const expectedFrameCount = pipeline.fullFrameCount + (pipeline.tailFrameSamples < pipeline.frameSamples ? 1 : 0)
  const pipelinePass = pipeline.outputSampleRate === 16000 &&
    pipeline.frameSamples === 1600 &&
    pipeline.inputSampleRate > 0 &&
    pipeline.sequenceGapCount === 0 &&
    pipeline.timestampRegressionCount === 0 &&
    pipeline.fullFrameCount >= 1 &&
    pipeline.tailFrameSamples > 0 &&
    pipeline.tailFrameSamples <= pipeline.frameSamples &&
    pipeline.frameCount === expectedFrameCount &&
    pipeline.sampleCount === levels.sampleCount &&
    clockCoverageRatio >= 0.9 && clockCoverageRatio <= 1.1 &&
    durationCoverageRatio >= 0.9
  const integrityPass = levels.nonFiniteCount === 0 && levels.overRangeCount === 0
  const round = (value) => Number(value.toFixed(6))
  return {
    clockCoverageRatio: round(clockCoverageRatio),
    durationCoverageRatio: round(durationCoverageRatio),
    pipelinePass,
    integrityPass,
    signalObserved: levels.signalObserved,
    pass: pipelinePass && integrityPass
  }
}

module.exports = {
  analyzeLevels,
  encodePcm16Wav,
  evaluateDiagnostic,
  parsePcm16Wav,
  sha256
}
