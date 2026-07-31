'use strict'

/* 隐藏音频宿主 renderer：getDisplayMedia（回环）/ getUserMedia（麦克风）
   → AudioWorklet 48k→16k mono → 定长帧。
   两种模式：
   - 有界诊断（B2.1）：采集 N 毫秒，指标与样本经 IPC 上报主进程。
   - 连续直通（B2.2）：帧经 MessagePort 直达 realtime worker，credit 背压 +
     有界队列（FrameFlow），主进程只收低频控制/指标，绝不经手 PCM。
   拓扑严格沿用 Gate 0C 批准版本：
   - 回环必须同时请求 video+audio，拿到流的瞬间停掉 video track；
   - 麦克风关闭 echoCancellation / noiseSuppression / autoGainControl；
   - 产品代码不包含任何机器特定的设备启发式，默认使用系统麦克风；I2 可把
     Gate 0C 产生的匿名 label SHA-256 作为 exact 选择证明，不接受设备明文。 */

const TARGET_SAMPLE_RATE = 16000
const FRAME_SAMPLES = 1600
const UNPROCESSED_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
const PCM_PORT_MESSAGE = 'audio-host:pcm-port'
const AUDIO_HOST_CLOCK_ID = 'audio-host-performance-v1'
const { FrameFlow } = window.FrameFlowModule
const { SpeechOnsetProbe } = window.SpeechOnsetProbeModule

function audioHostClockNowMs () {
  /* The host's timing evidence is on one monotonic renderer-local clock.
     It is converted only by the main-process calibration sampled at arm time. */
  return performance.now()
}

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

/** 在 user-gesture 窗口内立刻发起回环请求，video track 拿到即停（Gate 0C 硬不变量）。 */
function beginLoopbackAcquisition () {
  const promise = navigator.mediaDevices.getDisplayMedia({ video: true, audio: UNPROCESSED_AUDIO })
    .then(async (stream) => ({ stream, videoTrackCount: await stopVideoTracks(stream) }))
  promise.catch(() => {})
  return promise
}

async function resolveLoopback (displayPromise) {
  const { stream, videoTrackCount } = await displayPromise
  const audioTrack = stream.getAudioTracks()[0]
  if (!audioTrack) {
    for (const item of stream.getTracks()) item.stop()
    throw new Error('getDisplayMedia returned no loopback audio track')
  }
  if (audioTrack.readyState !== 'live') {
    for (const item of stream.getTracks()) item.stop()
    throw new Error('loopback audio track ended when the video track stopped')
  }
  return { stream, audioTrack, videoTrackCount }
}

async function acquireMicrophone (micLabelSha256 = null) {
  let audio = UNPROCESSED_AUDIO
  let selection = 'system-default'
  let matchedLabelHashCount = null
  if (micLabelSha256 !== null) {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    const matches = []
    for (const device of inputs) {
      if (await digestText(device.label) === micLabelSha256) {
        matches.push(device)
      }
    }
    matchedLabelHashCount = matches.length
    if (matches.length === 0) throw new DOMException('Expected microphone label hash is not available', 'NotFoundError')
    if (matches.length !== 1) throw new DOMException('Expected microphone label hash is ambiguous', 'NotFoundError')
    const selected = matches[0]
    audio = { ...UNPROCESSED_AUDIO, deviceId: { exact: selected.deviceId } }
    selection = 'label-hash-exact'
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio })
  const audioTrack = stream.getAudioTracks()[0]
  if (!audioTrack) {
    for (const item of stream.getTracks()) item.stop()
    throw new Error('getUserMedia returned no microphone audio track')
  }
  if (micLabelSha256 !== null && await digestText(audioTrack.label) !== micLabelSha256) {
    for (const item of stream.getTracks()) item.stop()
    throw new DOMException('Acquired microphone does not match the requested label hash', 'NotReadableError')
  }
  return { stream, audioTrack, selection, matchedLabelHashCount }
}

/** stream → worklet 管线。onFrame 收 {sequence, timestampSeconds, samples}。 */
async function createWorkletPipeline (stream, onFrame, onStopped) {
  const context = new AudioContext({ latencyHint: 'interactive' })
  await context.audioWorklet.addModule('capture-worklet.mjs')
  await context.resume()
  const contextAudioHostClockZeroMs = audioHostClockNowMs() - (context.currentTime * 1000)
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
  recorder.port.onmessage = (event) => {
    const message = event.data
    if (message?.type === 'frame') onFrame({ ...message, contextAudioHostClockZeroMs })
    else if (message?.type === 'stopped') onStopped(message)
  }
  return {
    context,
    stop: () => recorder.port.postMessage({ type: 'stop' }),
    teardown: async () => {
      mediaSource.disconnect()
      recorder.disconnect()
      await context.close().catch(() => {})
    }
  }
}

// --------------------------------------------------------------------------
// 模式一：有界诊断（B2.1）
// --------------------------------------------------------------------------

async function captureDiagnosticSource (stream, sessionId, sourceId, durationMs) {
  const frames = []
  const frameReceiptMs = []
  let recording = false
  let firstFrameResolve
  const firstFrame = new Promise((resolve) => { firstFrameResolve = resolve })
  let stoppedResolve
  const stopped = new Promise((resolve) => { stoppedResolve = resolve })
  let firstFrameLatencyMs = null
  const workletStarted = performance.now()

  const pipeline = await createWorkletPipeline(stream, (message) => {
    if (firstFrameLatencyMs === null) {
      firstFrameLatencyMs = performance.now() - workletStarted
      window.audioHost.mark(`${sourceId}:first-pcm`, { sequence: message.sequence })
      firstFrameResolve(message)
    }
    if (recording) {
      frames.push({ sequence: message.sequence, timestampSeconds: message.timestampSeconds, samples: message.samples })
      frameReceiptMs.push(performance.now())
    }
  }, (message) => stoppedResolve(message))

  try {
    await Promise.race([firstFrame, delay(5000).then(() => { throw new Error(`${sourceId} first PCM timed out`) })])
    recording = true
    const captureStarted = performance.now()
    const audioContextStarted = pipeline.context.currentTime
    await delay(durationMs)
    pipeline.stop()
    const stoppedResult = await Promise.race([stopped, delay(2000).then(() => { throw new Error('AudioWorklet stop timed out') })])
    const wallElapsedSeconds = (performance.now() - captureStarted) / 1000
    const audioContextElapsedSeconds = pipeline.context.currentTime - audioContextStarted

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
    const pipelineMetrics = {
      inputAudioContextSampleRate: pipeline.context.sampleRate,
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
    return await window.audioHost.saveDiagnostic({ sessionId, sourceId, samples, pipeline: pipelineMetrics })
  } finally {
    await pipeline.teardown()
  }
}

globalThis.runAudioHostDiagnostic = async function runAudioHostDiagnostic (options) {
  const { sessionId, sourceIds, durationMs } = options
  const displayPromise = sourceIds.includes('loopback') ? beginLoopbackAcquisition() : null
  const result = {}
  for (const sourceId of sourceIds) {
    window.audioHost.mark(`${sourceId}:capture-start`)
    let stream = null
    try {
      let evidence
      if (sourceId === 'loopback') {
        const loopback = await resolveLoopback(displayPromise)
        stream = loopback.stream
        evidence = { videoTrackCountBeforeStop: loopback.videoTrackCount, track: await trackEvidence(loopback.audioTrack) }
      } else {
        const microphone = await acquireMicrophone()
        stream = microphone.stream
        evidence = { selection: microphone.selection, track: await trackEvidence(microphone.audioTrack) }
      }
      const saved = await captureDiagnosticSource(stream, sessionId, sourceId, durationMs)
      result[sourceId] = { status: 'ok', stream: evidence, saved }
    } catch (error) {
      result[sourceId] = { status: 'error', error: errorEvidence(error) }
    } finally {
      if (stream) for (const item of stream.getTracks()) item.stop()
    }
  }
  return result
}

// --------------------------------------------------------------------------
// 模式二：连续 PCM 直通（B2.2）
// --------------------------------------------------------------------------

let pcmPort = null
let activeCapture = null

/* A tiny NTP-style probe endpoint. It contains only the renderer's monotonic
   clock scalars and is intentionally callable before/after media timing work.
   No PCM, text, device identity, or path can cross this boundary. */
globalThis.readAudioHostClockProbe = function readAudioHostClockProbe () {
  const remoteReceivedClockMs = audioHostClockNowMs()
  return {
    clockId: AUDIO_HOST_CLOCK_ID,
    remoteReceivedClockMs,
    remoteSentClockMs: audioHostClockNowMs()
  }
}

function timingMetrics (source) {
  const timing = source.timingProbe.snapshot(source.streamAudioHostClockEstimateMs)
  return {
    timingProbeArmedAudioHostClockMs: timing.armedAtClockMs,
    timingClockAnchorAudioHostClockMs: timing.clockAnchorClockMs,
    timingSpeechOnsetAudioMs: timing.speechOnsetAudioTimestampMs,
    timingSpeechOnsetEstimatedAudioHostClockMs: timing.speechOnsetEstimatedClockMs,
    timingSpeechOnsetObservedAudioHostClockMs: timing.speechOnsetObservedClockMs,
    timingSpeechOnsetFrameSequence: timing.speechOnsetFrameSequence,
    timingProbeDiscontinuities: timing.discontinuityCount,
    timingProbeInvalidSamples: timing.invalidSampleCount
  }
}

function sourceMetrics (source) {
  return { ...source.flow.metrics(), ...timingMetrics(source) }
}

/* I2-only timing probe. It resets immediately before controlled playback and
   observes samples in memory using the frozen Gate 0B onset rule. The method
   returns no PCM and is not exposed to visible renderers. */
globalThis.armCaptureTimingProbe = function armCaptureTimingProbe (options) {
  const capture = activeCapture
  if (!capture || capture.stopping) throw new Error('capture is not active')
  if (options?.sessionId !== capture.sessionId) throw new Error('timing probe session mismatch')
  const sourceId = String(options?.sourceId || '')
  const source = capture.sources.get(sourceId)
  if (!source || capture.sources.size !== 1) throw new Error('timing probe source mismatch')
  if (source.streamAudioHostClockEstimateMs === null) throw new Error('capture clock is not established')
  if (!Number.isFinite(options?.notBeforeAudioHostClockMs) || options.notBeforeAudioHostClockMs < 0) {
    throw new Error('timing probe source floor is invalid')
  }
  const armedAtAudioHostClockMs = audioHostClockNowMs()
  const audioFloorTimestampSeconds = Math.max(0,
    (options.notBeforeAudioHostClockMs - source.streamAudioHostClockEstimateMs) / 1000)
  source.timingProbe.arm(armedAtAudioHostClockMs, audioFloorTimestampSeconds)
  return { armed: true, sourceId, audioHostClockId: AUDIO_HOST_CLOCK_ID }
}

/* 主进程经 preload 转交 MessagePort。可在采集中途替换（worker 重建）：
   send 闭包动态引用 pcmPort，队列中的帧自动走新端口；旧端口关闭，
   旧 credit 作废（新消费端重新授信）。 */
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== PCM_PORT_MESSAGE) return
  const port = event.ports && event.ports[0]
  if (!port) return
  const previous = pcmPort
  pcmPort = port
  port.onmessage = (portEvent) => {
    const message = portEvent.data
    if (message?.type !== 'credits') return
    const source = activeCapture?.sources.get(message.sourceId)
    if (!source) return
    /* consumed 是消费端的显式确认，用于端口替换时的在途损失核算。 */
    if (Number.isInteger(message.consumed) && message.consumed > 0) source.flow.acknowledge(message.consumed)
    if (Number.isInteger(message.count) && message.count > 0) source.flow.grantCredits(message.count)
  }
  if (previous) {
    if (activeCapture) for (const source of activeCapture.sources.values()) source.flow.markPortReplaced()
    try { previous.close() } catch { /* already closed */ }
  }
  /* 采集中途换端口：向新消费端重新宣告 ready，让它授初始信用。
     只有 startAudioCapture 已完成宣告后才由这里补发——否则会与
     startAudioCapture 尾部的 ready 重复，把初始信用翻倍。 */
  if (activeCapture && activeCapture.readyAnnounced) {
    try {
      port.postMessage({ type: 'ready', sessionId: activeCapture.sessionId, sourceIds: [...activeCapture.sources.keys()] })
    } catch { /* port may already be gone */ }
  }
  window.audioHost.mark('pcm-port-attached', { replaced: !!previous })
})

globalThis.startAudioCapture = async function startAudioCapture (options) {
  const { sessionId, sourceIds, maxQueueMs, micLabelSha256 = null } = options
  if (!pcmPort) throw new Error('pcm port is not attached')
  if (activeCapture) throw new Error('capture is already running')
  const displayPromise = sourceIds.includes('loopback') ? beginLoopbackAcquisition() : null

  const capture = { sessionId, sources: new Map(), metricsTimer: null, stopping: false, readyAnnounced: false }
  activeCapture = capture
  try {
    const evidence = {}
    for (const sourceId of sourceIds) {
      let stream
      let audioTrack
      if (sourceId === 'loopback') {
        const loopback = await resolveLoopback(displayPromise)
        stream = loopback.stream
        audioTrack = loopback.audioTrack
        evidence[sourceId] = { videoTrackCountBeforeStop: loopback.videoTrackCount, track: await trackEvidence(audioTrack) }
      } else {
        const microphone = await acquireMicrophone(micLabelSha256)
        stream = microphone.stream
        audioTrack = microphone.audioTrack
        evidence[sourceId] = {
          selection: microphone.selection,
          matchedLabelHashCount: microphone.matchedLabelHashCount,
          track: await trackEvidence(audioTrack)
        }
      }

      const flow = new FrameFlow({
        maxQueueMs,
        sampleRate: TARGET_SAMPLE_RATE,
        /* 不用 transfer list：renderer DOM MessagePort → MessagePortMain 桥
           会静默丢弃带 ArrayBuffer transferable 的消息（实测：纯 JSON 的
           ready/end 可达、带 [samples.buffer] 的帧全部丢失）。结构化克隆
           1600×4B ≈ 6.4KB/帧、每路 10 帧/秒，拷贝成本可忽略。 */
        send: (frame) => { pcmPort.postMessage(frame) }
      })
      const source = {
        stream,
        flow,
        pipeline: null,
        stopped: null,
        timingProbe: new SpeechOnsetProbe({ sampleRate: TARGET_SAMPLE_RATE }),
        streamAudioHostClockEstimateMs: null
      }
      capture.sources.set(sourceId, source)

      audioTrack.addEventListener('ended', () => {
        if (capture.stopping || activeCapture !== capture) return
        window.audioHost.control({ type: 'track-ended', sessionId, sourceId })
      })

      let stoppedResolve
      source.stopped = new Promise((resolve) => { stoppedResolve = resolve })
      source.pipeline = await createWorkletPipeline(stream, (message) => {
        const captureAudioHostClockMs = audioHostClockNowMs()
        if (source.streamAudioHostClockEstimateMs === null &&
            Number.isFinite(message.contextAudioHostClockZeroMs) &&
            Number.isFinite(message.streamStartContextTimeSeconds)) {
          /* Map the worklet's sample timeline onto the renderer-local
             performance clock. Cross-process conversion is done once by the
             main controller, never with Date.now or a mixed clock here. */
          source.streamAudioHostClockEstimateMs = message.contextAudioHostClockZeroMs +
            (message.streamStartContextTimeSeconds * 1000)
        }
        const onset = source.timingProbe.observeFrame({
          samples: message.samples,
          timestampSeconds: message.timestampSeconds,
          sequence: message.sequence,
          ingressClockMs: captureAudioHostClockMs
        })
        flow.handleFrame({
          type: 'frame',
          sessionId,
          sourceId,
          sequence: message.sequence,
          timestampSeconds: message.timestampSeconds,
          audioHostClockId: AUDIO_HOST_CLOCK_ID,
          captureAudioHostClockMs: Number(captureAudioHostClockMs.toFixed(3)),
          sampleCount: message.samples.length,
          samples: message.samples,
          timing: onset && source.streamAudioHostClockEstimateMs !== null
            ? {
                audioHostClockId: AUDIO_HOST_CLOCK_ID,
                speechOnsetAudioTimestampMs: onset.onsetAudioTimestampMs,
                speechOnsetEstimatedAudioHostClockMs: Math.round(
                  source.streamAudioHostClockEstimateMs + onset.onsetAudioTimestampMs),
                speechOnsetObservedAudioHostClockMs: onset.observedAtClockMs,
                speechOnsetFrameSequence: onset.detectionFrameSequence
              }
            : null
        })
      }, (message) => stoppedResolve(message))
    }

    capture.metricsTimer = setInterval(() => {
      const sources = {}
      for (const [sourceId, source] of capture.sources) sources[sourceId] = sourceMetrics(source)
      window.audioHost.control({ type: 'metrics', sessionId, sources })
    }, 1000)
    /* ready 握手：所有 source 注册完毕后才宣告，消费端此时授初始信用。
       更早到达的 credit 会因找不到 source 被丢弃——不能依赖端口队列时序。 */
    capture.readyAnnounced = true
    pcmPort.postMessage({ type: 'ready', sessionId, sourceIds })
    window.audioHost.mark('capture-started', { sourceIds })
    return { sources: evidence }
  } catch (error) {
    activeCapture = null
    clearInterval(capture.metricsTimer)
    for (const source of capture.sources.values()) {
      try { await source.pipeline?.teardown() } catch { /* best effort */ }
      for (const item of source.stream.getTracks()) item.stop()
    }
    throw error
  }
}

globalThis.stopAudioCapture = async function stopAudioCapture () {
  const capture = activeCapture
  if (!capture) return { stopped: false }
  capture.stopping = true
  clearInterval(capture.metricsTimer)
  const metrics = {}
  for (const [sourceId, source] of capture.sources) {
    /* 停 worklet → flush 剩余帧（仍走 flow：有 credit 即发，无 credit 丢弃计数）。 */
    source.pipeline.stop()
    await Promise.race([source.stopped, delay(2000)])
    const discarded = source.flow.discardQueued()
    metrics[sourceId] = { ...sourceMetrics(source), discardedAtStop: discarded }
    for (const item of source.stream.getTracks()) item.stop()
    await source.pipeline.teardown()
  }
  activeCapture = null
  try { pcmPort.postMessage({ type: 'end', sessionId: capture.sessionId, metrics }) } catch { /* port may be gone */ }
  window.audioHost.control({ type: 'stopped', sessionId: capture.sessionId, sources: metrics })
  return { stopped: true, metrics }
}
