'use strict'

/* i2-live-caption-smoke 的播放页脚本（executeJavaScript 注入隐藏窗）。
   把 PCM16 base64 解码为 AudioBuffer 并外放；AudioContext 负责重采样到
   设备输出率。播放完成后 resolve 输出参数。 */

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
  await context.resume()
  const buffer = context.createBuffer(1, sampleCount, options.sampleRate)
  buffer.copyToChannel(samples, 0)
  const source = new AudioBufferSourceNode(context, { buffer })
  source.connect(context.destination)

  const done = new Promise((resolve) => { source.onended = resolve })
  const startedAt = context.currentTime
  source.start()
  await done
  const playedSeconds = context.currentTime - startedAt
  await context.close()
  return {
    sampleCount,
    inputSampleRate: options.sampleRate,
    outputSampleRate: context.sampleRate,
    playedSeconds
  }
}
