'use strict'

/* I2 真字幕实机 smoke（Gate 0B 改判后的模型接线验证）：
     .\node_modules\electron\dist\electron.exe scripts\i2-live-caption-smoke.js `
       --report .artifacts\i2-live\report.json
   链路（与 src/main.js 真实模型路径同构）：
     SessionCoordinator → RealtimeRuntimeAdapter（fast → x-asr-160ms，真实
     sherpa recognizer）→ AudioHostController（loopback）→ realtime worker
   动作：隐藏播放窗把受控语料 WAV（zh-en-code-switch）外放一遍，回环采回、
   真实模型解码，字幕经 acceptCaption 到达订阅者。
   判定：
   - 收到 final 且拼接 CER 达标 → pass
   - 零字幕且 worker peakRms≈0 → inconclusive-no-audio（系统静音/音量为零：
     回环采不到渲染音频；开音量重跑即可补齐，不作假判）
   - 其余 → fail
   会播放约 9 秒可听语音，且需要本机已解包的 Gate 0B 模型与语料。 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { RealtimeRuntimeAdapter } = require('../src/runtime/realtime-runtime-adapter')
const { resolveApprovedRealtimeModel, resolveApprovedRefinementModel, resolveSileroVadModel } = require('../src/main/services/model-resolver')
const { characterErrorRate } = require('./gate-0b/metrics')

const WAV_PATH = path.join(__dirname, '..', 'models', 'gate-0b', 'corpus', 'zh-en-code-switch.wav')
const REFERENCE = require('./gate-0b/corpus.json').cases.find((item) => item.id === 'zh-en-code-switch').reference
const CER_LIMIT = 0.3

function parseArguments (argv) {
  const options = { report: '.artifacts/i2-live/report.json' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return options
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/* 最小 WAV 读取：定位 fmt/data chunk，仅接受 PCM16 mono 16k（受控语料格式）。 */
function readPcm16MonoWav (filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22)
      }
    } else if (chunkId === 'data') {
      data = buffer.subarray(offset + 8, offset + 8 + chunkSize)
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (!format || !data) throw new Error('missing fmt/data chunk')
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error('expected PCM16 mono WAV')
  }
  return { sampleRate: format.sampleRate, pcm16Base64: Buffer.from(data).toString('base64'), durationSeconds: (data.length / 2) / format.sampleRate }
}

const PLAYER_SCRIPT = String(fs.readFileSync(path.join(__dirname, 'i2-live-caption-player.js'), 'utf8'))

async function playWave (wave) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  try {
    await window.loadURL('data:text/html,<title>i2-live-player</title>')
    /* 注入脚本的完成值是函数（不可克隆）；补一个可克隆的表达式收尾。 */
    await window.webContents.executeJavaScript(`${PLAYER_SCRIPT}\n;null`, true)
    return await window.webContents.executeJavaScript(
      `globalThis.playPcm16(${JSON.stringify({ pcm16Base64: wave.pcm16Base64, sampleRate: wave.sampleRate })})`,
      true
    )
  } finally {
    window.destroy()
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(path.dirname(reportPath), 'electron-user-data'))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  await app.whenReady()

  const failures = []
  const phases = []
  const captions = []
  const workers = []
  let coordinator = null
  const expect = (condition, label) => { if (!condition) failures.push(label) }

  try {
    const model = resolveApprovedRealtimeModel({ userDataDir: app.getPath('userData') })
    if (!model) throw new Error('approved realtime model not found on this machine')
    const vadModel = resolveSileroVadModel({ userDataDir: app.getPath('userData') })
    const refineModel = resolveApprovedRefinementModel({ userDataDir: app.getPath('userData') })
    const wave = readPcm16MonoWav(WAV_PATH)

    coordinator = new SessionCoordinator({
      adapterFactory: () => new RealtimeRuntimeAdapter({
        profileMap: { [model.profile]: model.id },
        recognizer: { kind: model.kind, modelDir: model.modelDir, numThreads: model.numThreads, modelType: model.modelType },
        vad: vadModel || undefined,
        refinement: refineModel
          ? { kind: refineModel.kind, modelDir: refineModel.modelDir, numThreads: refineModel.numThreads }
          : undefined,
        workerFactory: () => {
          const { RealtimeWorkerHost } = require('../src/runtime/realtime-worker/worker-host')
          const worker = new RealtimeWorkerHost()
          workers.push(worker)
          return worker
        }
      }),
      runtimeOptions: { modelOverride: { id: model.id, profile: model.profile, developmentOnly: false } },
      transitionTimeoutMs: 30000,
      configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true },
      idFactory: () => `i2-live-${Date.now()}`,
      onListenerError: (error) => failures.push(`listener error: ${String(error?.message || error).slice(0, 120)}`)
    })
    coordinator.onSnapshot((snapshot) => phases.push(snapshot.phase))
    coordinator.onCaption((event) => captions.push(event))

    const started = await coordinator.command('start')
    expect(started.ok === true, `start failed: ${started.code}`)
    expect(coordinator.getSnapshot().phase === 'listening', 'not listening after start')
    await delay(800)

    const playback = await playWave(wave)
    /* 尾静音窗口：VAD 收段（silero 默认 1.0s 收句）+ 模型冲刷 + 事件到达。 */
    await delay(3200)

    const stopped = await coordinator.command('stop')
    expect(stopped.ok === true, `stop failed: ${stopped.code}`)
    expect(coordinator.getSnapshot().phase === 'idle', 'not idle after stop')

    const finals = captions.filter((event) => event.kind === 'final')
    const partials = captions.filter((event) => event.kind === 'partial')
    const refined = captions.filter((event) => event.kind === 'refined')
    const joinedFinalText = finals.map((event) => event.text).join(' ')
    const joinedRefinedText = refined.map((event) => event.text).join(' ')
    const cer = finals.length > 0 ? characterErrorRate(REFERENCE, joinedFinalText) : null
    const refinedCer = refined.length > 0 ? characterErrorRate(REFERENCE, joinedRefinedText) : null
    const peakRms = workers.at(-1)?.lastStats?.sources?.loopback?.peakRms ?? null

    /* 精修断言（B3）：精修模型就位时必须有 refined 到达、内容达标且带标点
       （第一遍 160ms 短句几乎不出标点，标点恢复正是精修的存在理由）。 */
    if (refineModel) {
      if (finals.length > 0 && refined.length === 0) failures.push('refinement model active but no refined caption arrived')
      if (refined.length > 0) {
        if (refinedCer > CER_LIMIT) failures.push(`refined CER ${refinedCer} exceeds ${CER_LIMIT}`)
        if (!/[，。,.？?！!]/.test(joinedRefinedText)) failures.push(`refined text carries no punctuation: ${joinedRefinedText}`)
        for (const event of refined) {
          const final = finals.find((item) => item.segmentId === event.segmentId)
          if (!final) failures.push(`refined for unknown segment ${event.segmentId}`)
          else if (event.revision <= final.revision) failures.push(`refined revision ${event.revision} not above final ${final.revision}`)
        }
      }
    }

    let result
    if (finals.length > 0 && partials.length > 0 && cer !== null && cer <= CER_LIMIT && failures.length === 0) {
      result = 'pass'
    } else if (captions.length === 0 && (peakRms === null || peakRms < 0.001) && failures.length === 0) {
      result = 'inconclusive-no-audio'
    } else {
      result = 'fail'
      if (captions.length === 0) failures.push('no captions despite audible loopback audio')
      else if (finals.length === 0) failures.push('partials arrived but no final')
      else if (cer > CER_LIMIT) failures.push(`joined final CER ${cer} exceeds ${CER_LIMIT}`)
    }

    const report = {
      schemaVersion: 1,
      kind: 'i2-live-caption-smoke',
      executedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node },
      model: { id: model.id, profile: model.profile, numThreads: model.numThreads },
      vad: vadModel ? 'silero' : 'energy-fallback',
      refinement: refineModel ? refineModel.id : null,
      playback: { durationSeconds: wave.durationSeconds, outputSampleRate: playback.outputSampleRate },
      result,
      failures,
      phases,
      counts: { captions: captions.length, partials: partials.length, finals: finals.length, refined: refined.length },
      joinedFinalText,
      joinedRefinedText,
      cer,
      refinedCer,
      loopbackPeakRms: peakRms
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ result, cer, refinedCer, finals: finals.length, refined: refined.length, joinedRefinedText }) + '\n')
    await coordinator.dispose()
    app.exit(result === 'pass' ? 0 : (result === 'inconclusive-no-audio' ? 2 : 1))
  } catch (error) {
    console.error(error?.stack || error)
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        schemaVersion: 1,
        kind: 'i2-live-caption-smoke',
        result: 'error',
        error: String(error?.message || error).slice(0, 300),
        failures,
        phases
      }, null, 2) + '\n')
    } catch { /* best effort */ }
    if (coordinator) await coordinator.dispose().catch(() => {})
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
