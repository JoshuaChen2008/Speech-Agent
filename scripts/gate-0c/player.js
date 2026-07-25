'use strict'

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

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

async function selectOutput (context, outputMode) {
  if (outputMode === 'default') return { requested: outputMode, selected: 'default' }
  if (typeof context.setSinkId !== 'function') return { requested: outputMode, selected: 'default', fallbackReason: 'AudioContext.setSinkId-unavailable' }
  const devices = await navigator.mediaDevices.enumerateDevices()
  const outputs = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
  const selected = outputMode === 'virtual-cable'
    ? outputs.find((device) => /cable input.*vb-audio virtual cable/i.test(device.label))
    : [...outputs].sort((left, right) => physicalOutputScore(right.label) - physicalOutputScore(left.label))[0]
  const acceptable = outputMode === 'virtual-cable' ? Boolean(selected) : Boolean(selected && physicalOutputScore(selected.label) >= 3)
  if (!acceptable) return { requested: outputMode, selected: 'default', fallbackReason: `${outputMode}-not-enumerated` }
  try {
    await context.setSinkId(selected.deviceId)
    return {
      requested: outputMode,
      selected: outputMode === 'virtual-cable' ? 'virtual-cable' : 'physical-speaker-preferred',
      labelSha256: await digestText(selected.label),
      enumeratedAudioOutputCount: outputs.length
    }
  } catch (error) {
    return { requested: outputMode, selected: 'default', fallbackReason: error?.name || 'setSinkId-failed' }
  }
}

globalThis.playGate0CProbe = async function playGate0CProbe (options) {
  const frequencyHz = Number(options.frequencyHz)
  const amplitude = Number(options.amplitude)
  const startDelayMs = Number(options.startDelayMs)
  const durationMs = Number(options.durationMs)
  const fadeMs = Number(options.fadeMs)
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
  const context = new AudioContextClass({ latencyHint: 'interactive' })
  const output = await selectOutput(context, options.outputMode)
  await context.resume()

  const oscillator = new OscillatorNode(context, { type: 'sine', frequency: frequencyHz })
  const gain = new GainNode(context, { gain: 0 })
  oscillator.connect(gain).connect(context.destination)
  const start = context.currentTime + (startDelayMs / 1000)
  const fade = fadeMs / 1000
  const end = start + (durationMs / 1000)
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(amplitude, start + fade)
  gain.gain.setValueAtTime(amplitude, end - fade)
  gain.gain.linearRampToValueAtTime(0, end)
  oscillator.start(start)
  oscillator.stop(end + 0.01)

  await delay(startDelayMs + durationMs + fadeMs + 100)
  await context.close()
  return { sourceId: options.sourceId, frequencyHz, amplitude, startDelayMs, durationMs, fadeMs, outputSampleRate: context.sampleRate, output }
}
