'use strict'

/* 隐藏音频宿主 renderer：getDisplayMedia（回环）/ getUserMedia（麦克风）
   → AudioWorklet 48k→16k mono → 定长帧。B2.1 只做有界诊断采集与指标上报；
   连续 MessagePort 直通在 B2.2 接入。拓扑严格沿用 Gate 0C 批准版本：
   - 回环必须同时请求 video+audio，拿到后立即停掉 video track；
   - 麦克风关闭 echoCancellation / noiseSuppression / autoGainControl；
   - 产品代码不包含任何机器特定的设备启发式，麦克风用系统默认设备。 */

const TARGET_SAMPLE_RATE = 16000
const FRAME_SAMPLES = 1600
const UNPROCESSED_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorEvidence (error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 240) : String(error).slice(0, 240)
  }
}

async function digestText (value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/* 只上报不含身份信息的 track 证据：label 只留哈希。 */
async function trackEvidence (track) {
  const settings = track.getSettings()
  const keys = ['autoGainControl', 'channelCount', 'echoCancellation', 'latency', 'noiseSuppression', 'sampleRate', 'sampleSize']
  return {
    kind: track.kind,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    labelSha256: await digestText(track.label),
    settings: Object.fromEntries(keys.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]))
  }
}

async function stopVideoTracks (stream) {
  const videoTracks = stream.getVideoTracks()
  for (const track of videoTracks) track.stop()
  await delay(100)
  return videoTracks.length
}

/** 一路 stream → worklet → 帧收集 → 诊断上报。 */
async function captureSource (stream, sessionId, sourceId, durationMs) {
  const context = new AudioContext({ latencyHint: 'interactive' })
  try {
    await context.audioWorklet.addModule('capture-worklet.mjs')
    await context.resume()
    const mediaSource = context.createMediaStreamSource(stream)
    const recorder = new AudioWorkletNode(context, 'live-subtitle-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, frameSamples: FRAME_SAMPLES }
    })
    mediaSource.connect(recorder).connect(context.destination)

    const frames = []
    const frameReceiptMs = []
    let recording = false
    let firstFrameResolve
    const firstFrame = new Promise((resolve) => { firstFrameResolve = resolve })
    let stoppedResolve
    const stopped = new Promise((resolve) => { stoppedResolve = resolve })
    let firstFrameLatencyMs = null
    const workletStarted = performance.now()
    recorder.port.onmessage = (event) => {
      const message = event.data
      if (message?.type === 'frame') {
        if (firstFrameLatencyMs === null) {
          firstFrameLatencyMs = performance.now() - workletStarted
          window.audioHost.mark(`${sourceId}:first-pcm`, { sequence: message.sequence })
          firstFrameResolve(message)
        }
        if (recording) {
          frames.push({ sequence: message.sequence, timestampSeconds: message.timestampSeconds, samples: message.samples })
          frameReceiptMs.push(performance.now())
        }
      } else if (message?.type === 'stopped') stoppedResolve(message)
    }

    await Promise.race([firstFrame, delay(5000).then(() => { throw new Error(`${sourceId} first PCM timed out`) })])
    recording = true
    const captureStarted = performance.now()
    const audioContextStarted = context.currentTime
    await delay(durationMs)
    recorder.port.postMessage({ type: 'stop' })
    const stoppedResult = await Promise.race([stopped, delay(2000).then(() => { throw new Error('AudioWorklet stop timed out') })])
    const wallElapsedSeconds = (performance.now() - captureStarted) / 1000
    const audioContextElapsedSeconds = context.currentTime - audioContextStarted
    mediaSource.disconnect()
    recorder.disconnect()

    if (frames.length === 0) throw new Error(`${sourceId} produced no AudioWorklet frames`)
    let sequenceGapCount = 0
    let timestampRegressionCount = 0
    let frameIntervalMaxMs = 0
    for (let index = 0; index < frames.length; index += 1) {
      if (index > 0 && frames[index].sequence !== frames[index - 1].sequence + 1) sequenceGapCount += 1
      if (index > 0 && frames[index].timestampSeconds <= frames[index - 1].timestampSeconds) timestampRegressionCount += 1
      if (index > 0) frameIntervalMaxMs = Math.max(frameIntervalMaxMs, frameReceiptMs[index] - frameReceiptMs[index - 1])
    }
    const sampleCount = frames.reduce((sum, frame) => sum + frame.samples.length, 0)
    const samples = new Float32Array(sampleCount)
    let offset = 0
    for (const frame of frames) { samples.set(frame.samples, offset); offset += frame.samples.length }
    const frameLengths = frames.map((frame) => frame.samples.length)
    const pipeline = {
      inputAudioContextSampleRate: context.sampleRate,
      inputSampleRate: stoppedResult.inputSampleRate,
      outputSampleRate: TARGET_SAMPLE_RATE,
      frameSamples: FRAME_SAMPLES,
      frameCount: frames.length,
      firstSequence: frames[0].sequence,
      fullFrameCount: frameLengths.filter((length) => length === FRAME_SAMPLES).length,
      tailFrameSamples: frameLengths.at(-1),
      sequenceGapCount,
      timestampRegressionCount,
      sampleCount,
      firstFrameLatencyMs: Number((firstFrameLatencyMs ?? -1).toFixed(3)),
      frameIntervalMaxMs: Number(frameIntervalMaxMs.toFixed(3)),
      wallElapsedSeconds: Number(wallElapsedSeconds.toFixed(6)),
      audioContextElapsedSeconds: Number(audioContextElapsedSeconds.toFixed(6))
    }
    return await window.audioHost.saveDiagnostic({ sessionId, sourceId, samples, pipeline })
  } finally {
    await context.close().catch(() => {})
  }
}

async function captureLoopback (displayPromise, sessionId, durationMs) {
  const { stream, videoTrackCount } = await displayPromise
  try {
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) throw new Error('getDisplayMedia returned no loopback audio track')
    if (audioTrack.readyState !== 'live') throw new Error('loopback audio track ended when the video track stopped')
    const track = await trackEvidence(audioTrack)
    const saved = await captureSource(stream, sessionId, 'loopback', durationMs)
    return { status: 'ok', stream: { videoTrackCountBeforeStop: videoTrackCount, track }, saved }
  } finally {
    for (const item of stream.getTracks()) item.stop()
  }
}

async function captureMicrophone (sessionId, durationMs) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: UNPROCESSED_AUDIO })
  try {
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) throw new Error('getUserMedia returned no microphone audio track')
    const track = await trackEvidence(audioTrack)
    const saved = await captureSource(stream, sessionId, 'mic', durationMs)
    return { status: 'ok', stream: { track }, saved }
  } finally {
    for (const item of stream.getTracks()) item.stop()
  }
}

globalThis.runAudioHostDiagnostic = async function runAudioHostDiagnostic (options) {
  const { sessionId, sourceIds, durationMs } = options
  /* 回环的 getDisplayMedia 必须在 user-gesture 窗口内立刻发起；
     video track 必须在拿到流的瞬间停掉（Gate 0C 硬不变量），不能等到
     轮到 loopback 采集时才停——sourceIds 顺序是调用方决定的。
     立刻挂 catch 防 unhandledrejection；错误由 captureLoopback 消费。 */
  const displayPromise = sourceIds.includes('loopback')
    ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: UNPROCESSED_AUDIO })
        .then(async (stream) => ({ stream, videoTrackCount: await stopVideoTracks(stream) }))
    : null
  if (displayPromise) displayPromise.catch(() => {})
  const result = {}
  for (const sourceId of sourceIds) {
    window.audioHost.mark(`${sourceId}:capture-start`)
    try {
      result[sourceId] = sourceId === 'loopback'
        ? await captureLoopback(displayPromise, sessionId, durationMs)
        : await captureMicrophone(sessionId, durationMs)
    } catch (error) {
      result[sourceId] = { status: 'error', error: errorEvidence(error) }
    }
  }
  return result
}
