'use strict'

// @ts-check

/* PCM 诊断指标。现场样本只在内存中参与计算，不提供编码或落盘能力。
   诊断判定与 Gate 0C 的区别：产品诊断不放挑战音，静音是合法状态
   （系统可能就是没声音），只对「管线完整性」与「数据损坏」判失败，
   电平只报告不判定。 */

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
  evaluateDiagnostic
}
