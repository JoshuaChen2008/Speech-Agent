'use strict'

/* I2 真字幕实机 smoke（Gate 0B 改判后的模型接线验证）：
     .\scripts\run-electron-smoke.ps1 -EntryPoint scripts\i2-live-caption-smoke.js `
       -EntryArguments @('--source', 'loopback', '--report', '.artifacts\i2-live\loopback.json')
     .\scripts\run-electron-smoke.ps1 -EntryPoint scripts\i2-live-caption-smoke.js `
       -EntryArguments @('--source', 'mic', '--listen-seconds', '12', '--report', '.artifacts\i2-live\mic.json')
   链路（与 src/main.js 真实模型路径同构）：
     SessionCoordinator → RealtimeRuntimeAdapter（fast → x-asr-160ms，真实
     sherpa recognizer）→ AudioHostController（loopback）→ realtime worker
   动作：loopback 时隐藏播放窗把受控语料 WAV 外放一遍；mic 时提示操作者
   朗读同一冻结语料并在指定窗口采集。两种来源必须分开运行，永不并发。
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
const { scrubLocalPaths } = require('../src/runtime/audio-host/policy')
const { resolveApprovedRealtimeModel, resolveApprovedRefinementModel, resolveSileroVadModel } = require('../src/main/services/model-resolver')
const { characterErrorRate, percentile } = require('./gate-0b/metrics')

const WAV_PATH = path.join(__dirname, '..', 'models', 'gate-0b', 'corpus', 'zh-en-code-switch.wav')
const REFERENCE_CASE = require('./gate-0b/corpus.json').cases.find((item) => item.id === 'zh-en-code-switch')
const REFERENCE = REFERENCE_CASE.reference
const CER_LIMIT = 0.3

function parseArguments (argv) {
  const options = { report: '.artifacts/i2-live/report.json', source: null, listenSeconds: 12 }
  let sourceSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--report') { options.report = value; index += 1 } else if (argv[index] === '--source') {
      if (sourceSeen) throw new Error('--source must be provided exactly once')
      sourceSeen = true
      options.source = value; index += 1
    } else if (argv[index] === '--listen-seconds') {
      options.listenSeconds = Number(value); index += 1
    } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source is required and must be loopback or mic')
  if (typeof options.report !== 'string' || options.report.trim().length === 0) throw new Error('--report must be a non-empty path')
  if (!Number.isFinite(options.listenSeconds) || options.listenSeconds < 5 || options.listenSeconds > 60) {
    throw new Error('--listen-seconds must be between 5 and 60')
  }
  return options
}

function safeDiagnosticText (value) {
  return scrubLocalPaths(String(value ?? 'unknown')).slice(0, 300)
}

function buildMicPromptNotice (listenSeconds) {
  return {
    status: 'awaiting-microphone-speech',
    seconds: listenSeconds,
    promptId: REFERENCE_CASE.id
  }
}

function buildReport ({
  executedAt,
  environment,
  sourceId,
  result,
  model,
  vad,
  refinement,
  stimulus,
  failures,
  phases,
  counts,
  accuracy,
  timings,
  resources,
  peakRms,
  diagnostics
}) {
  const capture = diagnostics?.capture?.[sourceId] || {}
  const worker = diagnostics?.worker || {}
  const source = worker.sources?.[sourceId] || {}
  return {
    schemaVersion: 2,
    kind: 'i2-live-caption-smoke',
    executedAt,
    environment,
    sourceId,
    result,
    model,
    vad,
    refinement,
    stimulus,
    failures: failures.map(safeDiagnosticText),
    phases,
    counts,
    accuracy,
    timings,
    resources,
    signal: { peakRms },
    transport: {
      capturedFrames: capture.capturedFrames ?? null,
      sentFrames: capture.sentFrames ?? null,
      ingestedFrames: source.framesIngested ?? null,
      droppedFrames: capture.droppedFrames ?? null,
      creditStalls: capture.creditStalls ?? null,
      maxQueuedMsObserved: capture.maxQueuedMsObserved ?? null,
      acknowledgedFrames: capture.acknowledgedFrames ?? null,
      lostInFlightFrames: capture.lostInFlightFrames ?? null,
      portReplacements: capture.portReplacements ?? null,
      queuedFramesAtStop: capture.queuedFrames ?? null,
      queuedMsAtStop: capture.queuedMs ?? null,
      discardedAtStop: capture.discardedAtStop ?? null,
      sequenceGapCount: source.sequenceGapCount ?? null,
      missedFrames: source.missedFrames ?? null,
      badSampleTypeFrames: worker.badSampleTypeFrames ?? null,
      droppedCaptionCount: diagnostics?.droppedCaptionCount ?? null
    },
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false
    },
    limitations: sourceId === 'loopback'
      ? [
          'This is one real loopback run, not a latency percentile study.',
          'Physical microphone evidence remains pending and must be produced by a separate --source mic run.'
        ]
      : [
          'This is one real physical microphone run, not a latency percentile study.',
          'This source-specific run does not replace the separate loopback evidence.'
        ]
  }
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

function startResourceSampler () {
  const samples = []
  const take = () => {
    try {
      const appMetrics = app.getAppMetrics()
      const totalCpuPercent = appMetrics.reduce((sum, metric) => sum + (Number(metric.cpu?.percentCPUUsage) || 0), 0)
      const workingSetKiB = appMetrics.reduce((sum, metric) => sum + (Number(metric.memory?.workingSetSize) || 0), 0)
      samples.push({
        atMs: Date.now(),
        processCount: appMetrics.length,
        totalCpuPercent: Number(totalCpuPercent.toFixed(3)),
        workingSetMiB: Number((workingSetKiB / 1024).toFixed(3))
      })
    } catch { /* metrics are observational; capture failure is reported by an empty sample set */ }
  }
  take()
  const timer = setInterval(take, 250)
  return {
    stop () {
      clearInterval(timer)
      take()
      const cpu = samples.map((sample) => sample.totalCpuPercent)
      const memory = samples.map((sample) => sample.workingSetMiB)
      return {
        sampleCount: samples.length,
        cpuPercent: { p50: percentile(cpu, 0.5), p95: percentile(cpu, 0.95), max: cpu.length ? Math.max(...cpu) : null },
        workingSetMiB: { p50: percentile(memory, 0.5), p95: percentile(memory, 0.95), max: memory.length ? Math.max(...memory) : null },
        maxProcessCount: samples.length ? Math.max(...samples.map((sample) => sample.processCount)) : null
      }
    }
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  app.on('window-all-closed', () => {})
  /* report 可以是受版本控制的证据路径；Chromium profile 永远留在 ignored
     artifacts，不能在报告旁生成 Cache/Local Storage 等无关目录。 */
  const smokeUserDataPath = path.join(__dirname, '..', '.artifacts', 'i2-live', 'electron-user-data')
  fs.mkdirSync(smokeUserDataPath, { recursive: true })
  app.setPath('userData', smokeUserDataPath)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  await app.whenReady()

  const failures = []
  const phases = []
  const captions = []
  const captionArrivals = []
  const workers = []
  let coordinator = null
  let runtimeAdapter = null
  let resourceSampler = null
  const expect = (condition, label) => { if (!condition) failures.push(label) }

  try {
    const model = resolveApprovedRealtimeModel({ userDataDir: app.getPath('userData') })
    if (!model) throw new Error('approved realtime model not found on this machine')
    const vadModel = resolveSileroVadModel({ userDataDir: app.getPath('userData') })
    const refineModel = resolveApprovedRefinementModel({ userDataDir: app.getPath('userData') })
    const wave = readPcm16MonoWav(WAV_PATH)

    const configuration = options.source === 'loopback'
      ? { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true }
      : { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false }
    coordinator = new SessionCoordinator({
      adapterFactory: () => {
        runtimeAdapter = new RealtimeRuntimeAdapter({
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
        })
        return runtimeAdapter
      },
      runtimeOptions: { modelOverride: { id: model.id, profile: model.profile, developmentOnly: false } },
      transitionTimeoutMs: 30000,
      configuration,
      idFactory: () => `i2-live-${Date.now()}`,
      onListenerError: (error) => failures.push(`listener error: ${safeDiagnosticText(error?.message || error).slice(0, 120)}`)
    })
    coordinator.onSnapshot((snapshot) => phases.push(snapshot.phase))
    coordinator.onCaption((event) => {
      captions.push(event)
      captionArrivals.push({ kind: event.kind, segmentId: event.segmentId, arrivedAtMs: Date.now() })
    })

    resourceSampler = startResourceSampler()
    const started = await coordinator.command('start')
    expect(started.ok === true, `start failed: ${started.code}`)
    expect(coordinator.getSnapshot().phase === 'listening', 'not listening after start')
    await delay(800)

    const stimulusStartedAtMs = Date.now()
    let playback = null
    if (options.source === 'loopback') {
      playback = await playWave(wave)
    } else {
      process.stdout.write(JSON.stringify(buildMicPromptNotice(options.listenSeconds)) + '\n')
      await delay(options.listenSeconds * 1000)
    }
    const stimulusEndedAtMs = Date.now()
    /* 尾静音窗口：VAD 收段（silero 默认 1.0s 收句）+ 模型冲刷 + 事件到达。 */
    await delay(3200)

    const stopped = await coordinator.command('stop')
    expect(stopped.ok === true, `stop failed: ${stopped.code}`)
    expect(coordinator.getSnapshot().phase === 'idle', 'not idle after stop')

    const finals = captions.filter((event) => event.kind === 'final')
    const partials = captions.filter((event) => event.kind === 'partial')
    const refined = captions.filter((event) => event.kind === 'refined')
    /* 现场正文只在内存中用于准确率判定，绝不进入 report/stdout。 */
    const finalTextForScoring = finals.map((event) => event.text).join(' ')
    const refinedTextForScoring = refined.map((event) => event.text).join(' ')
    const cer = finals.length > 0 ? characterErrorRate(REFERENCE, finalTextForScoring) : null
    const refinedCer = refined.length > 0 ? characterErrorRate(REFERENCE, refinedTextForScoring) : null
    const refinedHasPunctuation = refined.length > 0 ? /[，。,.？?！!]/.test(refinedTextForScoring) : null
    const peakRms = workers.at(-1)?.lastStats?.sources?.[options.source]?.peakRms ?? null
    const diagnostics = runtimeAdapter?.getLastRunDiagnostics() || null
    const resources = resourceSampler.stop()
    resourceSampler = null
    const firstArrival = (kind) => captionArrivals.find((item) => item.kind === kind)?.arrivedAtMs ?? null
    const relative = (value, origin) => value === null ? null : Math.max(0, value - origin)
    const timings = {
      firstPartialFromStimulusStartMs: relative(firstArrival('partial'), stimulusStartedAtMs),
      firstFinalFromStimulusStartMs: relative(firstArrival('final'), stimulusStartedAtMs),
      firstRefinedFromStimulusStartMs: relative(firstArrival('refined'), stimulusStartedAtMs),
      firstFinalAfterStimulusEndMs: firstArrival('final') === null ? null : firstArrival('final') - stimulusEndedAtMs,
      captionArrivalCount: captionArrivals.length
    }

    const sourceDiagnostics = diagnostics?.worker?.sources?.[options.source] || null
    const captureDiagnostics = diagnostics?.capture?.[options.source] || null
    if (sourceDiagnostics?.badSampleTypeFrames > 0 || diagnostics?.worker?.badSampleTypeFrames > 0) {
      failures.push('worker observed malformed PCM sample types')
    }
    if (sourceDiagnostics?.sequenceGapCount > 0 || sourceDiagnostics?.missedFrames > 0) {
      failures.push('worker observed PCM sequence gaps')
    }
    if (captureDiagnostics?.droppedFrames > 0) failures.push('audio host dropped PCM frames')
    if (diagnostics?.droppedCaptionCount > 0) failures.push('worker host rejected caption events')

    /* 精修断言（B3）：精修模型就位时必须有 refined 到达、内容达标且带标点
       （第一遍 160ms 短句几乎不出标点，标点恢复正是精修的存在理由）。 */
    if (refineModel) {
      if (finals.length > 0 && refined.length === 0) failures.push('refinement model active but no refined caption arrived')
      if (refined.length > 0) {
        if (refinedCer > CER_LIMIT) failures.push(`refined CER ${refinedCer} exceeds ${CER_LIMIT}`)
        if (!refinedHasPunctuation) failures.push('refined text carries no punctuation')
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
      if (captions.length === 0) failures.push(`no captions despite active ${options.source} audio`)
      else if (finals.length === 0) failures.push('partials arrived but no final')
      else if (cer > CER_LIMIT) failures.push(`joined final CER ${cer} exceeds ${CER_LIMIT}`)
    }

    const report = buildReport({
      executedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node },
      sourceId: options.source,
      result,
      model: { id: model.id, profile: model.profile, numThreads: model.numThreads },
      vad: vadModel ? 'silero' : 'energy-fallback',
      refinement: refineModel ? refineModel.id : null,
      stimulus: options.source === 'loopback'
        ? { kind: 'controlled-playback', corpusId: REFERENCE_CASE.id, durationSeconds: wave.durationSeconds, outputSampleRate: playback.outputSampleRate }
        : { kind: 'operator-spoken-prompt', corpusId: REFERENCE_CASE.id, listenSeconds: options.listenSeconds },
      failures,
      phases,
      counts: { captions: captions.length, partials: partials.length, finals: finals.length, refined: refined.length },
      accuracy: { finalCer: cer, refinedCer, refinedHasPunctuation },
      timings,
      resources,
      peakRms,
      diagnostics
    })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      result,
      sourceId: options.source,
      counts: report.counts,
      accuracy: report.accuracy,
      timings: report.timings,
      transport: report.transport
    }) + '\n')
    await coordinator.dispose()
    app.exit(result === 'pass' ? 0 : (result === 'inconclusive-no-audio' ? 2 : 1))
  } catch (error) {
    console.error(safeDiagnosticText(error?.stack || error))
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        schemaVersion: 2,
        kind: 'i2-live-caption-smoke',
        result: 'error',
        error: safeDiagnosticText(error?.message || error),
        failures: failures.map(safeDiagnosticText),
        phases,
        privacy: {
          capturedAudioPersisted: false,
          reportContainsTranscriptText: false,
          reportContainsAudioPath: false
        }
      }, null, 2) + '\n')
    } catch { /* best effort */ }
    if (coordinator) await coordinator.dispose().catch(() => {})
    if (resourceSampler) resourceSampler.stop()
    app.exit(1)
  }
}

/* Electron 启动主脚本时 require.main 并不可靠；Node 测试 require 本文件时
   又必须保持纯导入，所以用 Electron main-process 身份作为入口守卫。 */
if (process.versions.electron && process.type === 'browser') {
  main().catch((error) => {
    console.error(safeDiagnosticText(error?.stack || error))
    app.exit(1)
  })
}

module.exports = { buildMicPromptNotice, buildReport, parseArguments, safeDiagnosticText }
