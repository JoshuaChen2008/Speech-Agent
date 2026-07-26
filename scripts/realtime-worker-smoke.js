'use strict'

/* B2.3 realtime worker 骨架的实机 smoke：
     .\node_modules\electron\dist\electron.exe scripts\realtime-worker-smoke.js `
       --report .artifacts\realtime-worker\report.json
   链路：audio host（loopback）→ MessageChannelMain → realtime worker
   （EnergyVad + NullRecognizerAdapter）。运行期间由隐形 player 窗播放两段
   997Hz 挑战音（短暂可听，与 Gate 0C 同款）。
   断言：
   - worker 消费到全部帧（无 sequence 缺口、无丢帧）；
   - captionsEmitted === 0 —— Gate 0B 未通过，null adapter 绝不产文本，
     骨架不得伪造任何字幕；
   - 挑战音真实进入回环（peakRms>=0.05）时，VAD 必须检测到 >=1 个语音段。
   结果三态：pass（有声且全过）/ inconclusive-silent（系统静音，传输与
   零字幕断言通过但 VAD 分段无法验证，exit 2）/ fail（exit 1）。 */

const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow, MessageChannelMain, app } = require('electron')
const { AudioHostController } = require('../src/runtime/audio-host/audio-host-controller')
const { RealtimeWorkerHost } = require('../src/runtime/realtime-worker/worker-host')

/* 与 Gate 0C player 同款的隐形放音窗：WebAudio 振荡器两段 997Hz（各 1.2s、
   间隔 0.9s 静音），经默认输出被 loopback 采到。会短暂可听。 */
async function playChallengeTones () {
  const win = new BrowserWindow({
    x: -10000,
    y: -10000,
    width: 200,
    height: 100,
    show: false,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { backgroundThrottling: false }
  })
  try {
    win.webContents.setAudioMuted(false)
    await win.loadURL('about:blank')
    win.showInactive()
    await win.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext()
      await context.resume()
      const play = (ms) => new Promise((resolve) => {
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.frequency.value = 997
        gain.gain.value = 0.25
        osc.connect(gain).connect(context.destination)
        osc.start()
        setTimeout(() => { osc.stop(); resolve() }, ms)
      })
      await play(1200)
      await new Promise((resolve) => setTimeout(resolve, 900))
      await play(1200)
      await context.close()
      return true
    })()`, true)
  } finally {
    win.destroy()
  }
}

function parseArguments (argv) {
  const options = { report: '.artifacts/realtime-worker/report.json' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return options
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(path.dirname(reportPath), 'electron-user-data'))
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  await app.whenReady()

  const sessionId = `realtime-worker-smoke-${Date.now()}`
  const sourceIds = ['loopback']
  const controller = new AudioHostController({ onEvidence: () => {} })
  const worker = new RealtimeWorkerHost()
  const captions = []
  worker.onCaption((event) => captions.push(event))

  const failures = []
  try {
    await worker.start({
      sessionId,
      sourceIds,
      recognizerProfile: 'null',
      /* beep 幅度约 0.5：阈值取 0.05，2 帧确认、5 帧收尾。 */
      vadOptions: { threshold: 0.05, voicedFramesToStart: 2, silentFramesToEnd: 5 }
    })
    const channel = new MessageChannelMain()
    worker.attachPort(channel.port2)
    await controller.startCapture({ sessionId, sourceIds, maxQueueMs: 1000, port: channel.port1 })

    await delay(500)
    await playChallengeTones()
    await delay(1200)

    const stopResult = await controller.stopCapture()
    worker.requestStats()
    await delay(700)

    const workerStats = worker.lastStats?.sources?.loopback || null
    const transport = worker.lastStats
      ? {
          badSampleTypeFrames: worker.lastStats.badSampleTypeFrames ?? null,
          sampleTypeObserved: worker.lastStats.sampleTypeObserved ?? null,
          endReceived: worker.lastStats.endReceived ?? null
        }
      : null
    const hostMetrics = stopResult?.metrics?.loopback || null
    if (!workerStats) failures.push('missing worker stats')
    if (!hostMetrics) failures.push('missing host metrics')
    if (transport && transport.badSampleTypeFrames !== 0) {
      failures.push(`${transport.badSampleTypeFrames} frames with unusable sample payloads (${transport.sampleTypeObserved})`)
    }
    let signalObserved = false
    if (workerStats && hostMetrics) {
      if (workerStats.framesIngested < 40) failures.push(`only ${workerStats.framesIngested} frames ingested`)
      if (workerStats.sequenceGapCount !== 0) failures.push(`${workerStats.sequenceGapCount} sequence gaps at worker`)
      if (hostMetrics.droppedFrames !== 0) failures.push(`${hostMetrics.droppedFrames} frames dropped at host`)
      if (workerStats.captionsEmitted !== 0) failures.push(`null adapter must not emit captions, got ${workerStats.captionsEmitted}`)
      if (captions.length !== 0) failures.push(`${captions.length} caption events reached the host`)
      /* VAD 分段断言以真实有声为前提：系统静音（挑战音没进回环）时
         判 inconclusive 而不是假失败——静音下断言分段就是在要求 VAD 幻听。 */
      signalObserved = workerStats.peakRms >= 0.05
      if (signalObserved && workerStats.segmentsDetected < 1) {
        failures.push('signal was audible but VAD detected no speech segment')
      }
    }
    const result = failures.length > 0
      ? 'fail'
      : (signalObserved ? 'pass' : 'inconclusive-silent')

    const report = {
      schemaVersion: 1,
      kind: 'realtime-worker-smoke',
      executedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node },
      result,
      failures,
      workerStats,
      transport,
      hostMetrics,
      captionCount: captions.length
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      result: report.result,
      failures,
      framesIngested: workerStats?.framesIngested ?? null,
      segmentsDetected: workerStats?.segmentsDetected ?? null,
      captionsEmitted: workerStats?.captionsEmitted ?? null,
      peakRms: workerStats?.peakRms ?? null
    }) + '\n')
    controller.dispose()
    worker.dispose()
    app.exit(result === 'fail' ? 1 : (result === 'pass' ? 0 : 2))
  } catch (error) {
    console.error(error?.stack || error)
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        schemaVersion: 1,
        kind: 'realtime-worker-smoke',
        result: 'error',
        error: String(error?.message || error).slice(0, 300),
        workerStats: worker.lastStats,
        captionCount: captions.length
      }, null, 2) + '\n')
    } catch { /* best effort */ }
    controller.dispose()
    worker.dispose()
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
