'use strict'

const TARGET_SAMPLE_RATE = 16000
const FRAME_SAMPLES = 1600
const UNPROCESSED_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function digestText (value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function activationSnapshot () {
  return {
    isActive: navigator.userActivation?.isActive === true,
    hasBeenActive: navigator.userActivation?.hasBeenActive === true
  }
}

function publicTrackSettings (settings) {
  const keys = ['autoGainControl', 'channelCount', 'echoCancellation', 'latency', 'noiseSuppression', 'sampleRate', 'sampleSize']
  return Object.fromEntries(keys.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]))
}

async function trackEvidence (track) {
  return {
    kind: track.kind,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    labelSha256: await digestText(track.label),
    settings: publicTrackSettings(track.getSettings())
  }
}

function errorEvidence (error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 240) : String(error).slice(0, 240)
  }
}

async function stopVideoAndInspect (stream) {
  const videoTracks = stream.getVideoTracks()
  const audioTracks = stream.getAudioTracks()
  for (const track of videoTracks) track.stop()
  await delay(100)
  return {
    audioTrackCount: audioTracks.length,
    videoTrackCountBeforeStop: videoTracks.length,
    audioReadyStateAfterVideoStop: audioTracks[0]?.readyState || null
  }
}

async function createRecorder (stream, sourceId, durationMs, probe) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
  const context = new AudioContextClass({ latencyHint: 'interactive' })
  await context.audioWorklet.addModule('capture-worklet.mjs')
  await context.resume()
  const mediaSource = context.createMediaStreamSource(stream)
  const recorder = new AudioWorkletNode(context, 'gate-0c-pcm-capture', {
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
  let firstFrameMarked = false
  let recording = false
  let firstFrameResolve
  const firstFrame = new Promise((resolve) => { firstFrameResolve = resolve })
  let stoppedResolve
  const stopped = new Promise((resolve) => { stoppedResolve = resolve })
  recorder.port.onmessage = (event) => {
    const message = event.data
    if (message?.type === 'frame') {
      if (!firstFrameMarked) {
        firstFrameMarked = true
        window.gate0c.mark(`${sourceId}:first-pcm`, { sequence: message.sequence })
        firstFrameResolve(message)
      }
      if (recording) frames.push({ sequence: message.sequence, timestampSeconds: message.timestampSeconds, samples: message.samples })
    } else if (message?.type === 'stopped') stoppedResolve(message)
  }

  await Promise.race([firstFrame, delay(5000).then(() => { throw new Error(`${sourceId} first PCM timed out`) })])
  recording = true
  const captureStarted = performance.now()
  const audioContextStarted = context.currentTime
  const playback = await window.gate0c.playProbe({
    ...probe,
    sourceId,
    outputMode: sourceId === 'mic-probe' ? 'virtual-cable' : (sourceId === 'mic' ? 'physical-speaker' : 'default')
  })
  const remaining = durationMs - (performance.now() - captureStarted)
  if (remaining > 0) await delay(remaining)
  recorder.port.postMessage({ type: 'stop' })
  const stoppedResult = await Promise.race([stopped, delay(2000).then(() => { throw new Error('AudioWorklet stop timed out') })])
  const wallElapsedSeconds = (performance.now() - captureStarted) / 1000
  const audioContextElapsedSeconds = context.currentTime - audioContextStarted
  mediaSource.disconnect()
  recorder.disconnect()
  await context.close()

  if (frames.length === 0) throw new Error(`${sourceId} produced no AudioWorklet frames`)
  let sequenceGapCount = 0
  let timestampRegressionCount = 0
  for (let index = 0; index < frames.length; index += 1) {
    if (index > 0 && frames[index].sequence !== frames[index - 1].sequence + 1) sequenceGapCount += 1
    if (index > 0 && frames[index].timestampSeconds <= frames[index - 1].timestampSeconds) timestampRegressionCount += 1
  }
  const sampleCount = frames.reduce((sum, frame) => sum + frame.samples.length, 0)
  const samples = new Float32Array(sampleCount)
  let offset = 0
  for (const frame of frames) { samples.set(frame.samples, offset); offset += frame.samples.length }
  const frameLengths = frames.map((frame) => frame.samples.length)
  const pipeline = {
    inputAudioContextSampleRate: stoppedResult.inputSampleRate,
    outputSampleRate: TARGET_SAMPLE_RATE,
    frameSamples: FRAME_SAMPLES,
    frameCount: frames.length,
    firstSequence: frames[0].sequence,
    fullFrameCount: frameLengths.filter((length) => length === FRAME_SAMPLES).length,
    tailFrameSamples: frameLengths.at(-1),
    sequenceGapCount,
    timestampRegressionCount,
    sampleCount,
    wallElapsedSeconds: Number(wallElapsedSeconds.toFixed(6)),
    audioContextElapsedSeconds: Number(audioContextElapsedSeconds.toFixed(6))
  }
  const diagnostic = await window.gate0c.analyzeCapture({
    sourceId,
    samples,
    pipeline,
    expectedFrequencyHz: probe.frequencyHz,
    probeWindow: { startSeconds: probe.startDelayMs / 1000, durationSeconds: probe.durationMs / 1000 }
  })
  return { playback, pipeline, diagnostic }
}

async function captureLoopback (displayPromise, durationMs, probe) {
  const stream = await displayPromise
  const stopEvidence = await stopVideoAndInspect(stream)
  const audioTrack = stream.getAudioTracks()[0]
  if (!audioTrack) throw new Error('getDisplayMedia returned no loopback audio track')
  if (audioTrack.readyState !== 'live') throw new Error('loopback audio track ended when the video track stopped')
  const track = await trackEvidence(audioTrack)
  try {
    const capture = await createRecorder(stream, 'loopback', durationMs, probe)
    return { status: 'ok', stream: { ...stopEvidence, track }, capture }
  } finally {
    for (const item of stream.getTracks()) item.stop()
  }
}

function physicalMicrophoneScore (label) {
  const value = label.toLowerCase()
  if (/realtek/.test(value) && /阵列|array/.test(value)) return 5
  if ((/麦克风 \(realtek/.test(value) || /microphone \(realtek/.test(value)) && !/阵列|array/.test(value)) return 4
  if (/hx-kz03/.test(value)) return 3
  if (/nvidia broadcast/.test(value)) return 0
  if (/cable|virtual|pico|网易/.test(value)) return 0
  return 1
}

async function openMicrophone (mode) {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const microphones = devices.filter((device) => device.kind === 'audioinput')
  const enumerated = microphones.filter((device) => device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
  const candidates = mode === 'virtual-cable'
    ? enumerated.filter((device) => /cable output.*vb-audio virtual cable/i.test(device.label))
    : enumerated.filter((device) => physicalMicrophoneScore(device.label) >= 2).sort((left, right) => physicalMicrophoneScore(right.label) - physicalMicrophoneScore(left.label))
  if (mode !== 'virtual-cable') candidates.push(null)
  const failures = []
  for (const candidate of candidates) {
    try {
      const audio = candidate ? { ...UNPROCESSED_AUDIO, deviceId: { exact: candidate.deviceId } } : UNPROCESSED_AUDIO
      const stream = await navigator.mediaDevices.getUserMedia({ audio })
      const score = candidate ? physicalMicrophoneScore(candidate.label) : null
      return {
        stream,
        selection: mode === 'virtual-cable' ? 'virtual-cable' : (candidate ? (score >= 2 ? 'physical-preferred' : 'enumerated-fallback') : 'default-fallback'),
        deviceCount: microphones.length,
        failedCandidateCount: failures.length
      }
    } catch (error) {
      failures.push(errorEvidence(error))
    }
  }
  const summary = failures.map((failure) => failure.name).join(', ')
  throw new DOMException(`All ${candidates.length} microphone candidates failed: ${summary}`, 'NotReadableError')
}

async function captureMicrophone (durationMs, probe, mode = 'physical') {
  const opened = await openMicrophone(mode)
  const sourceId = mode === 'virtual-cable' ? 'mic-probe' : 'mic'
  const audioTrack = opened.stream.getAudioTracks()[0]
  if (!audioTrack) throw new Error('getUserMedia returned no microphone audio track')
  const track = await trackEvidence(audioTrack)
  try {
    const capture = await createRecorder(opened.stream, sourceId, durationMs, probe)
    return { status: 'ok', selection: opened.selection, enumeratedAudioInputCount: opened.deviceCount, failedCandidateCount: opened.failedCandidateCount, stream: { audioTrackCount: 1, track }, capture }
  } finally {
    for (const item of opened.stream.getTracks()) item.stop()
  }
}

globalThis.probeDisplayMediaWithoutGesture = async function probeDisplayMediaWithoutGesture () {
  const activation = activationSnapshot()
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: UNPROCESSED_AUDIO })
    const stopEvidence = await stopVideoAndInspect(stream)
    for (const track of stream.getTracks()) track.stop()
    return { status: 'resolved', activation, stream: stopEvidence }
  } catch (error) {
    return { status: 'rejected', activation, error: errorEvidence(error) }
  }
}

globalThis.runGate0C = async function runGate0C (options) {
  const activationAtInvocation = activationSnapshot()
  const displayPromise = navigator.mediaDevices.getDisplayMedia({ video: true, audio: UNPROCESSED_AUDIO })
  const result = { activationAtInvocation, loopback: null, mic: null, micProbe: null }
  try {
    result.loopback = await captureLoopback(displayPromise, options.durationMs, options.probe)
  } catch (error) {
    result.loopback = { status: 'error', error: errorEvidence(error) }
  }
  try {
    result.mic = await captureMicrophone(options.durationMs, options.probe)
  } catch (error) {
    result.mic = { status: 'error', error: errorEvidence(error) }
  }
  try {
    result.micProbe = await captureMicrophone(options.durationMs, options.probe, 'virtual-cable')
  } catch (error) {
    result.micProbe = { status: 'error', error: errorEvidence(error) }
  }
  return result
}
