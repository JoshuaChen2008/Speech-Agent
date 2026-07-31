'use strict'

const PLAYBACK_CLOCK_ID = 'playback-renderer-performance-v1'
const MIN_SCHEDULE_LEAD_MS = 50
const MAX_SCHEDULE_LEAD_MS = 2000

/* i2-live-caption-smoke 的播放页脚本（executeJavaScript 注入隐藏窗）。
   把 PCM16 base64 解码为 AudioBuffer 并外放；AudioContext 负责重采样到
   设备输出率。mic fixture 只选择 Gate 0C 的 physical-preferred 输出候选；
   这是标签启发式连续性证明，不是硬件证明，报告仅留 label 哈希。 */

async function digestText (value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function physicalOutputScore (label) {
  const value = label.toLowerCase()
  if ((/扬声器.*realtek/.test(value) || /speakers.*realtek/.test(value)) && !/耳机|headphone/.test(value)) return 5
  if (/nvidia broadcast/.test(value)) return 0
  if (/realtek/.test(value)) return 3
  if (/cable|virtual|pico|网易/.test(value)) return 0
  return 1
}

async function selectOutput (context, outputMode, expectedLabelSha256 = null) {
  if (outputMode === 'default') return { requested: outputMode, selected: 'default' }
  if (outputMode !== 'physical-speaker') throw new TypeError('unsupported output mode')
  if (!/^[a-f0-9]{64}$/.test(expectedLabelSha256 || '')) throw new TypeError('physical speaker label hash is required')
  if (typeof context.setSinkId !== 'function') throw new Error('AudioContext.setSinkId is unavailable')
  const devices = await navigator.mediaDevices.enumerateDevices()
  const outputs = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
  const hashedOutputs = []
  for (const device of outputs) {
    hashedOutputs.push({ device, labelSha256: await digestText(device.label) })
  }
  const matches = hashedOutputs.filter((candidate) => candidate.labelSha256 === expectedLabelSha256)
  if (matches.length === 0) throw new Error('Expected physical-preferred speaker label hash is unavailable')
  if (matches.length !== 1) throw new Error('Expected physical-preferred speaker label hash is ambiguous')
  const selected = matches[0]
  if (physicalOutputScore(selected.device.label) < 3) throw new Error('Expected speaker no longer satisfies the physical-preferred heuristic')
  await context.setSinkId(selected.device.deviceId)
  return {
    requested: 'physical-speaker-hash',
    selected: 'label-hash-exact-physical-preferred',
    labelSha256: selected.labelSha256,
    matchedLabelHashCount: matches.length,
    enumeratedAudioOutputCount: outputs.length
  }
}

function readOutputProjection (context, sourceStartContextTimeSeconds) {
  if (typeof context.getOutputTimestamp !== 'function') return null
  try {
    const value = context.getOutputTimestamp()
    if (!Number.isFinite(value?.contextTime) || value.contextTime < 0 ||
        !Number.isFinite(value?.performanceTime) || value.performanceTime <= 0) return null
    return value.performanceTime +
      ((sourceStartContextTimeSeconds - value.contextTime) * 1000)
  } catch {
    return null
  }
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function sampleOutputProjection (context, sourceStartContextTimeSeconds) {
  const projections = []
  let elapsedMs = 0
  for (const waitMs of [0, 25, 75]) {
    if (waitMs > elapsedMs) await delay(waitMs - elapsedMs)
    elapsedMs = waitMs
    const projection = readOutputProjection(context, sourceStartContextTimeSeconds)
    if (Number.isFinite(projection)) projections.push(projection)
  }
  projections.sort((left, right) => left - right)
  if (projections.length === 0) {
    return { method: typeof context.getOutputTimestamp === 'function' ? 'invalid' : 'unavailable', samples: [] }
  }
  return { method: 'get-output-timestamp-projection', samples: projections }
}

let preparedPlayback = null
let activePlayback = null

globalThis.readPlaybackClockProbe = function readPlaybackClockProbe () {
  const remoteReceivedClockMs = performance.now()
  const remoteSentClockMs = performance.now()
  return { clockId: PLAYBACK_CLOCK_ID, remoteReceivedClockMs, remoteSentClockMs }
}

globalThis.preparePcm16 = async function preparePcm16 (options) {
  if (preparedPlayback || activePlayback) throw new Error('playback is already prepared')
  const binary = atob(options.pcm16Base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const view = new DataView(bytes.buffer)
  const sampleCount = Math.floor(bytes.length / 2)
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768
  }

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
  const context = new AudioContextClass({ latencyHint: 'interactive' })
  try {
    const output = await selectOutput(context, options.outputMode || 'default', options.expectedOutputLabelSha256 || null)
    await context.resume()
    const outputSampleRate = context.sampleRate
    const buffer = context.createBuffer(1, sampleCount, options.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = new AudioBufferSourceNode(context, { buffer })
    source.connect(context.destination)
    preparedPlayback = { context, source, output, outputSampleRate, sampleCount, inputSampleRate: options.sampleRate }
    return { prepared: true }
  } catch (error) {
    if (context.state !== 'closed') await context.close().catch(() => {})
    throw error
  }
}

globalThis.startPreparedPcm16 = function startPreparedPcm16 (options) {
  const prepared = preparedPlayback
  if (!prepared) throw new Error('playback is not prepared')
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).length !== 1 || !Object.hasOwn(options, 'notBeforeClockMs') ||
      !Number.isFinite(options.notBeforeClockMs)) {
    throw new TypeError('one scheduled playback clock is required')
  }
  const { context, source, output, outputSampleRate, sampleCount, inputSampleRate } = prepared
  const schedulingClockMs = performance.now()
  const scheduleLeadMs = options.notBeforeClockMs - schedulingClockMs
  if (scheduleLeadMs < MIN_SCHEDULE_LEAD_MS || scheduleLeadMs > MAX_SCHEDULE_LEAD_MS) {
    throw new RangeError('scheduled playback clock is outside the bounded future window')
  }
  preparedPlayback = null
  const done = new Promise((resolve) => { source.onended = resolve })
  const startedAt = context.currentTime + (scheduleLeadMs / 1000)
  const sourceStartClockMs = schedulingClockMs + scheduleLeadMs
  try {
    source.start(startedAt)
    const projectionPromise = sampleOutputProjection(context, startedAt)
    activePlayback = {
      context,
      done,
      inputSampleRate,
      output,
      outputSampleRate,
      projectionPromise,
      sampleCount,
      startedAt
    }
    return { started: true, clockId: PLAYBACK_CLOCK_ID, sourceStartClockMs }
  } catch (error) {
    if (context.state !== 'closed') void context.close().catch(() => {})
    throw error
  }
}

globalThis.finishPreparedPcm16 = async function finishPreparedPcm16 () {
  const active = activePlayback
  if (!active) throw new Error('playback is not active')
  activePlayback = null
  const {
    context,
    done,
    inputSampleRate,
    output,
    outputSampleRate,
    projectionPromise,
    sampleCount,
    startedAt
  } = active
  try {
    await done
    const projection = await projectionPromise
    const endedAtClockMs = performance.now()
    const playedSeconds = context.currentTime - startedAt
    const projectionMedian = projection.samples.length > 0
      ? projection.samples[Math.floor(projection.samples.length / 2)]
      : null
    const projectionSpreadMs = projection.samples.length > 0
      ? projection.samples.at(-1) - projection.samples[0]
      : null
    const projectionStable = projectionMedian !== null && projectionSpreadMs <= 20
    const projectionMethod = projection.samples.length > 0 && !projectionStable
      ? 'unstable'
      : projection.method
    return {
      sampleCount,
      inputSampleRate,
      outputSampleRate,
      playedSeconds,
      endedAtClockMs,
      timing: {
        method: projectionMethod,
        sourceStartContextTimeSeconds: Number(startedAt.toFixed(6)),
        baseLatencyMs: Number.isFinite(context.baseLatency)
          ? Number((context.baseLatency * 1000).toFixed(3))
          : null,
        outputLatencyMs: Number.isFinite(context.outputLatency)
          ? Number((context.outputLatency * 1000).toFixed(3))
          : null,
        validProjectionSampleCount: projection.samples.length,
        projectionSpreadMs: projectionSpreadMs === null ? null : Number(projectionSpreadMs.toFixed(3)),
        estimatedFirstSamplePresentationClockMs: !projectionStable ? null : projectionMedian,
        estimatedLastSamplePresentationClockMs: !projectionStable
          ? null
          : projectionMedian + (sampleCount / inputSampleRate) * 1000
      },
      output
    }
  } finally {
    if (context.state !== 'closed') await context.close().catch(() => {})
  }
}
