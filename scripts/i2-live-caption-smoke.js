'use strict'

/* I2 真字幕实机 smoke（Gate 0B 改判后的模型接线验证）：
     .\scripts\run-electron-smoke.ps1 -EntryPoint scripts\i2-live-caption-smoke.js `
       -EntryArguments @('--source', 'loopback', '--report', '.artifacts\i2-live\loopback.json')
     .\scripts\run-electron-smoke.ps1 -EntryPoint scripts\i2-live-caption-smoke.js `
       -EntryArguments @('--source', 'mic', '--listen-seconds', '12', '--report', '.artifacts\i2-live\mic.json')
     .\scripts\run-electron-smoke.ps1 -EntryPoint scripts\i2-live-caption-smoke.js `
       -EntryArguments @('--source', 'mic', '--mic-stimulus', 'acoustic-replay', `
         '--physical-mic-preflight', '.artifacts\gate-0c\report.json', `
         '--report', '.artifacts\i2-live\mic-acoustic.json')
   链路（与 src/main.js 真实模型路径同构）：
     SessionCoordinator → RealtimeRuntimeAdapter（fast → x-asr-160ms，真实
     sherpa recognizer）→ AudioHostController（loopback）→ realtime worker
   动作：loopback 时隐藏播放窗把受控语料 WAV 外放一遍；mic 可提示操作者
   朗读，或在先通过 Gate 0C 的同一 physical-preferred 麦克风前由同一
   physical-preferred 扬声器回放冻结语料。这里的 preferred 是标签启发式，
   不是硬件证明。两种来源必须分开运行，永不并发。
   判定：
   - 收到 final 且拼接 CER 达标 → pass
   - 零字幕且 worker peakRms≈0 → inconclusive-no-audio（系统静音/音量为零：
     回环采不到渲染音频；开音量重跑即可补齐，不作假判）
   - 其余 → fail
   会播放约 9 秒可听语音，且需要本机已解包的 Gate 0B 模型与语料。 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { RealtimeRuntimeAdapter } = require('../src/runtime/realtime-runtime-adapter')
const { resolveApprovedRealtimeModel, resolveApprovedRefinementModel, resolveSileroVadModel } = require('../src/main/services/model-resolver')
const { characterErrorRate, percentile } = require('./gate-0b/metrics')
const { validateGate0CMetricsReport } = require('./gate-0c/verify-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { assertSafeSerializedReport, validateI2LiveReport } = require('./verify-i2-live-report')

const WAV_PATH = path.join(__dirname, '..', 'models', 'gate-0b', 'corpus', 'zh-en-code-switch.wav')
const REFERENCE_CASE = require('./gate-0b/corpus.json').cases.find((item) => item.id === 'zh-en-code-switch')
const REFERENCE = REFERENCE_CASE.reference
const REFERENCE_SHA256 = crypto.createHash('sha256').update(REFERENCE, 'utf8').digest('hex')
const CER_LIMIT = 0.3

function parseArguments (argv) {
  const options = {
    report: '.artifacts/i2-live/report.json',
    source: null,
    listenSeconds: 12,
    micStimulus: 'operator',
    physicalMicPreflight: null
  }
  let sourceSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--report') { options.report = value; index += 1 } else if (argv[index] === '--source') {
      if (sourceSeen) throw new Error('--source must be provided exactly once')
      sourceSeen = true
      options.source = value; index += 1
    } else if (argv[index] === '--listen-seconds') {
      options.listenSeconds = Number(value); index += 1
    } else if (argv[index] === '--mic-stimulus') {
      options.micStimulus = value; index += 1
    } else if (argv[index] === '--physical-mic-preflight') {
      options.physicalMicPreflight = value; index += 1
    } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source is required and must be loopback or mic')
  if (typeof options.report !== 'string' || options.report.trim().length === 0) throw new Error('--report must be a non-empty path')
  if (!Number.isFinite(options.listenSeconds) || options.listenSeconds < 5 || options.listenSeconds > 60) {
    throw new Error('--listen-seconds must be between 5 and 60')
  }
  if (!['operator', 'acoustic-replay'].includes(options.micStimulus)) {
    throw new Error('--mic-stimulus must be operator or acoustic-replay')
  }
  if (options.source === 'loopback' && (options.micStimulus !== 'operator' || options.physicalMicPreflight !== null)) {
    throw new Error('mic stimulus options are only valid with --source mic')
  }
  if (options.source === 'mic' && options.micStimulus === 'acoustic-replay' &&
      (typeof options.physicalMicPreflight !== 'string' || options.physicalMicPreflight.trim().length === 0)) {
    throw new Error('--physical-mic-preflight is required for acoustic-replay')
  }
  return options
}

function buildMicPromptNotice (listenSeconds) {
  return {
    status: 'awaiting-microphone-speech',
    seconds: listenSeconds,
    promptId: REFERENCE_CASE.id
  }
}

function buildFailureReport ({ sourceId, phases }) {
  const safePhases = new Set(['idle', 'starting', 'listening', 'pausing', 'paused', 'resuming', 'stopping', 'error'])
  if (!['loopback', 'mic'].includes(sourceId)) throw new TypeError('failure report sourceId must be loopback or mic')
  return {
    schemaVersion: 4,
    kind: 'i2-live-caption-smoke-failure',
    sourceId,
    result: 'error',
    errorCode: 'i2-live-run-failed',
    phases: Array.isArray(phases) ? phases.filter((phase) => safePhases.has(phase)).slice(0, 16) : [],
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false,
      reportContainsDiagnosticText: false
    }
  }
}

function normalizeFailureCodes (failures) {
  if (!Array.isArray(failures)) throw new TypeError('failures must be an array')
  return failures.map((code) => {
    if (typeof code !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 80) {
      throw new TypeError('failure entries must be bounded fixed codes')
    }
    return code
  })
}

function readPhysicalMicPreflight (filePath) {
  const reportBytes = fs.readFileSync(path.resolve(filePath))
  const report = parseStrictEvidenceJson(reportBytes, 'Gate 0C preflight')
  validateGate0CMetricsReport(report)
  const track = report?.capture?.mic?.stream?.track
  const output = report?.capture?.mic?.capture?.playback?.output
  if (report?.schemaVersion !== 2 || report?.gate !== '0C' || report?.result !== 'pass') {
    throw new Error('physical-preferred microphone preflight is not a passing Gate 0C report')
  }
  if (report?.decision?.physicalMicrophonePass !== true || report?.capture?.mic?.selection !== 'physical-preferred') {
    throw new Error('Gate 0C preflight did not select a physical-preferred microphone')
  }
  if (output?.selected !== 'physical-speaker-preferred') {
    throw new Error('Gate 0C preflight did not select a physical-preferred speaker')
  }
  if (!/^[a-f0-9]{64}$/.test(track?.labelSha256 || '')) {
    throw new Error('physical-preferred preflight has no valid input label hash')
  }
  if (!/^[a-f0-9]{64}$/.test(output?.labelSha256 || '')) {
    throw new Error('physical-preferred preflight has no valid output label hash')
  }
  if (!Number.isFinite(Date.parse(report.executedAt))) {
    throw new Error('physical-preferred preflight has no valid execution timestamp')
  }
  if (report?.privacy?.rawAudioPersisted !== false) {
    throw new Error('physical-preferred preflight does not prove memory-only capture')
  }
  return {
    kind: 'gate-0c-audio-topology',
    schemaVersion: 2,
    reportSha256: crypto.createHash('sha256').update(reportBytes).digest('hex'),
    runId: report.runId,
    executedAt: report.executedAt,
    result: report.result,
    physicalMicrophoneSelection: 'physical-preferred',
    physicalSpeakerSelection: 'physical-speaker-preferred',
    micLabelSha256: track.labelSha256,
    speakerLabelSha256: output.labelSha256,
    rawAudioPersisted: false
  }
}

function safeTrackEvidence (diagnostics, sourceId) {
  const track = diagnostics?.input?.sources?.[sourceId]?.track
  if (!track) return null
  const allowedSettings = ['autoGainControl', 'channelCount', 'echoCancellation', 'latency', 'noiseSuppression', 'sampleRate', 'sampleSize']
  return {
    kind: track.kind,
    labelSha256: track.labelSha256,
    settings: Object.fromEntries(allowedSettings.filter((key) => track.settings?.[key] !== undefined).map((key) => [key, track.settings[key]]))
  }
}

function safeInputEvidence (diagnostics, sourceId) {
  const input = diagnostics?.input?.sources?.[sourceId]
  return {
    selection: typeof input?.selection === 'string' ? input.selection : null,
    matchedLabelHashCount: Number.isInteger(input?.matchedLabelHashCount) ? input.matchedLabelHashCount : null,
    track: safeTrackEvidence(diagnostics, sourceId)
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
  preflight,
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
    schemaVersion: 4,
    kind: 'i2-live-caption-smoke',
    executedAt,
    environment,
    sourceId,
    result,
    model,
    vad,
    refinement,
    stimulus,
    preflight: preflight || null,
    input: safeInputEvidence(diagnostics, sourceId),
    failures: normalizeFailureCodes(failures),
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
          'This source-specific report does not attest a physical-preferred microphone fixture; use the separate --source mic evidence.'
        ]
      : stimulus?.kind === 'controlled-physical-speaker-playback'
        ? [
            'This is one real physical-preferred microphone acoustic-fixture run, not a hardware attestation or latency percentile study.',
            'Physical-preferred is a label heuristic; acoustic geometry and room noise make results machine-specific.',
            'This source-specific run does not replace the separate loopback evidence.'
          ]
      : [
          'This is one real operator-spoken microphone run, not a device-class attestation or latency percentile study.',
          'This source-specific run does not replace the separate loopback evidence.'
        ]
  }
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/* 与 Gate 0B 首 partial 基准相同：连续两个 20ms 窗口高于 -45dBFS。 */
function findSpeechOnsetMsPcm16 (data, sampleRate) {
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.02))
  const threshold = 10 ** (-45 / 20)
  const sampleCount = Math.floor(data.length / 2)
  let consecutive = 0
  for (let offset = 0; offset < sampleCount; offset += windowSamples) {
    const end = Math.min(sampleCount, offset + windowSamples)
    let energy = 0
    for (let index = offset; index < end; index += 1) {
      const sample = data.readInt16LE(index * 2) / 32768
      energy += sample * sample
    }
    const rms = Math.sqrt(energy / Math.max(1, end - offset))
    consecutive = rms >= threshold ? consecutive + 1 : 0
    if (consecutive >= 2) return (Math.max(0, offset - windowSamples) / sampleRate) * 1000
  }
  return null
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
  return {
    sampleRate: format.sampleRate,
    pcm16Base64: Buffer.from(data).toString('base64'),
    corpusSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    durationSeconds: (data.length / 2) / format.sampleRate,
    speechOnsetOffsetMs: findSpeechOnsetMsPcm16(data, format.sampleRate)
  }
}

async function playWave (wave, outputMode = 'default', expectedOutputLabelSha256 = null) {
  const partition = `i2-playback-${process.pid}-${Date.now()}`
  const playbackSession = session.fromPartition(partition, { cache: false })
  const window = new BrowserWindow({
    width: 240,
    height: 120,
    x: -10000,
    y: -10000,
    show: false,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const trustedContentsId = window.webContents.id
  playbackSession.setPermissionCheckHandler((webContents, permission) =>
    webContents?.id === trustedContentsId && permission === 'speaker-selection')
  playbackSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(webContents?.id === trustedContentsId && permission === 'speaker-selection'))
  try {
    await window.loadFile(path.join(__dirname, 'i2-live-caption-player.html'))
    window.showInactive()
    window.webContents.setAudioMuted(false)
    return await window.webContents.executeJavaScript(
      `globalThis.playPcm16(${JSON.stringify({ pcm16Base64: wave.pcm16Base64, sampleRate: wave.sampleRate, outputMode, expectedOutputLabelSha256 })})`,
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
    const physicalPreflight = options.physicalMicPreflight
      ? readPhysicalMicPreflight(options.physicalMicPreflight)
      : null

    const configuration = options.source === 'loopback'
      ? { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true }
      : { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false }
    coordinator = new SessionCoordinator({
      adapterFactory: () => {
        runtimeAdapter = new RealtimeRuntimeAdapter({
        profileMap: { [model.profile]: model.id },
        micLabelSha256: physicalPreflight?.micLabelSha256 || null,
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
      onListenerError: () => failures.push('listener-error')
    })
    coordinator.onSnapshot((snapshot) => phases.push(snapshot.phase))
    coordinator.onCaption((event) => {
      captions.push(event)
      captionArrivals.push({ kind: event.kind, segmentId: event.segmentId, arrivedAtMs: Date.now() })
    })

    resourceSampler = startResourceSampler()
    const started = await coordinator.command('start')
    expect(started.ok === true, 'coordinator-start-failed')
    expect(coordinator.getSnapshot().phase === 'listening', 'listening-phase-not-reached')
    await delay(800)

    let stimulusStartedAtMs = Date.now()
    let stimulusEndedAtMs = null
    let playback = null
    if (options.source === 'loopback') {
      playback = await playWave(wave, 'default')
    } else if (options.micStimulus === 'acoustic-replay') {
      playback = await playWave(wave, 'physical-speaker', physicalPreflight.speakerLabelSha256)
    } else {
      process.stdout.write(JSON.stringify(buildMicPromptNotice(options.listenSeconds)) + '\n')
      await delay(options.listenSeconds * 1000)
    }
    if (playback) {
      stimulusStartedAtMs = playback.startedAtEpochMs
      stimulusEndedAtMs = playback.endedAtEpochMs
    } else {
      stimulusEndedAtMs = Date.now()
    }
    /* 尾静音窗口：VAD 收段（silero 默认 1.0s 收句）+ 模型冲刷 + 事件到达。 */
    await delay(3200)

    const stopped = await coordinator.command('stop')
    expect(stopped.ok === true, 'coordinator-stop-failed')
    expect(coordinator.getSnapshot().phase === 'idle', 'idle-phase-not-reached')

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
    const inputTrack = safeTrackEvidence(diagnostics, options.source)
    const resources = resourceSampler.stop()
    resourceSampler = null
    const firstArrival = (kind) => captionArrivals.find((item) => item.kind === kind)?.arrivedAtMs ?? null
    const relative = (value, origin) => value === null ? null : Math.max(0, value - origin)
    const timings = {
      firstPartialFromStimulusStartMs: relative(firstArrival('partial'), stimulusStartedAtMs),
      firstPartialFromEstimatedSpeechOnsetMs: playback && wave.speechOnsetOffsetMs !== null
        ? relative(firstArrival('partial'), stimulusStartedAtMs + wave.speechOnsetOffsetMs)
        : null,
      firstFinalFromStimulusStartMs: relative(firstArrival('final'), stimulusStartedAtMs),
      firstRefinedFromStimulusStartMs: relative(firstArrival('refined'), stimulusStartedAtMs),
      firstFinalAfterStimulusEndMs: firstArrival('final') === null ? null : firstArrival('final') - stimulusEndedAtMs,
      captionArrivalCount: captionArrivals.length
    }

    const sourceDiagnostics = diagnostics?.worker?.sources?.[options.source] || null
    const captureDiagnostics = diagnostics?.capture?.[options.source] || null
    if (sourceDiagnostics?.badSampleTypeFrames > 0 || diagnostics?.worker?.badSampleTypeFrames > 0) {
      failures.push('worker-malformed-pcm-type')
    }
    if (sourceDiagnostics?.sequenceGapCount > 0 || sourceDiagnostics?.missedFrames > 0) {
      failures.push('worker-pcm-sequence-gap')
    }
    if (captureDiagnostics?.droppedFrames > 0) failures.push('audio-host-dropped-pcm-frame')
    if (diagnostics?.droppedCaptionCount > 0) failures.push('worker-host-rejected-caption-event')
    if (options.source === 'mic' && options.micStimulus === 'acoustic-replay') {
      if (playback?.output?.selected !== 'label-hash-exact-physical-preferred' || playback?.output?.matchedLabelHashCount !== 1) {
        failures.push('speaker-label-match-not-unique')
      }
      if (playback?.output?.labelSha256 !== physicalPreflight?.speakerLabelSha256) {
        failures.push('speaker-preflight-hash-mismatch')
      }
      if (!/^[a-f0-9]{64}$/.test(inputTrack?.labelSha256 || '')) {
        failures.push('microphone-label-hash-missing')
      } else if (inputTrack.labelSha256 !== physicalPreflight?.micLabelSha256) {
        failures.push('microphone-preflight-hash-mismatch')
      }
      if (diagnostics?.input?.sources?.mic?.matchedLabelHashCount !== 1) {
        failures.push('microphone-label-match-not-unique')
      }
    }

    /* 精修断言（B3）：精修模型就位时必须有 refined 到达、内容达标且带标点
       （第一遍 160ms 短句几乎不出标点，标点恢复正是精修的存在理由）。 */
    if (refineModel) {
      if (finals.length > 0 && refined.length === 0) failures.push('refined-caption-missing')
      if (refined.length > 0) {
        if (refinedCer > CER_LIMIT) failures.push('refined-cer-exceeded')
        if (!refinedHasPunctuation) failures.push('refined-punctuation-missing')
        for (const event of refined) {
          const final = finals.find((item) => item.segmentId === event.segmentId)
          if (!final) failures.push('refined-segment-unknown')
          else if (event.revision <= final.revision) failures.push('refined-revision-invalid')
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
      if (captions.length === 0) failures.push('caption-missing-with-active-audio')
      else if (finals.length === 0) failures.push('final-caption-missing')
      else if (cer > CER_LIMIT) failures.push('final-cer-exceeded')
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
        ? { kind: 'controlled-playback', corpusId: REFERENCE_CASE.id, corpusSha256: wave.corpusSha256, referenceSha256: REFERENCE_SHA256, durationSeconds: wave.durationSeconds, speechOnsetOffsetMs: wave.speechOnsetOffsetMs, outputSampleRate: playback.outputSampleRate, output: playback.output }
        : options.micStimulus === 'acoustic-replay'
          ? { kind: 'controlled-physical-speaker-playback', corpusId: REFERENCE_CASE.id, corpusSha256: wave.corpusSha256, referenceSha256: REFERENCE_SHA256, durationSeconds: wave.durationSeconds, speechOnsetOffsetMs: wave.speechOnsetOffsetMs, outputSampleRate: playback.outputSampleRate, output: playback.output }
          : { kind: 'operator-spoken-prompt', corpusId: REFERENCE_CASE.id, corpusSha256: wave.corpusSha256, referenceSha256: REFERENCE_SHA256, listenSeconds: options.listenSeconds },
      preflight: physicalPreflight,
      failures,
      phases,
      counts: { captions: captions.length, partials: partials.length, finals: finals.length, refined: refined.length },
      accuracy: { finalCer: cer, refinedCer, refinedHasPunctuation },
      timings,
      resources,
      peakRms,
      diagnostics
    })
    if (result === 'pass') validateI2LiveReport(report, options.source)
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
  } catch {
    console.error(JSON.stringify({ result: 'error', errorCode: 'i2-live-run-failed' }))
    try {
      const failureReport = buildFailureReport({ sourceId: options.source, phases })
      assertSafeSerializedReport(failureReport)
      fs.writeFileSync(reportPath, JSON.stringify(failureReport, null, 2) + '\n')
    } catch { /* best effort */ }
    if (coordinator) await coordinator.dispose().catch(() => {})
    if (resourceSampler) resourceSampler.stop()
    app.exit(1)
  }
}

/* Electron 启动主脚本时 require.main 并不可靠；Node 测试 require 本文件时
   又必须保持纯导入，所以用 Electron main-process 身份作为入口守卫。 */
if (process.versions.electron && process.type === 'browser') {
  main().catch(() => {
    console.error(JSON.stringify({ result: 'error', errorCode: 'i2-live-entry-failed' }))
    app.exit(1)
  })
}

module.exports = { buildFailureReport, buildMicPromptNotice, buildReport, findSpeechOnsetMsPcm16, normalizeFailureCodes, parseArguments, readPhysicalMicPreflight, safeInputEvidence, safeTrackEvidence }
