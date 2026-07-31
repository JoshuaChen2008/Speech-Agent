'use strict'

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

globalThis.playPcm16 = async function playPcm16 (options) {
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

    const done = new Promise((resolve) => { source.onended = resolve })
    const startedAt = context.currentTime
    const startedAtEpochMs = Date.now()
    source.start()
    await done
    const endedAtEpochMs = Date.now()
    const playedSeconds = context.currentTime - startedAt
    return {
      sampleCount,
      inputSampleRate: options.sampleRate,
      outputSampleRate,
      playedSeconds,
      startedAtEpochMs,
      endedAtEpochMs,
      output
    }
  } finally {
    if (context.state !== 'closed') await context.close().catch(() => {})
  }
}
