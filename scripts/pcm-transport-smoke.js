'use strict'

/* B2.2 PCM 直通实机 smoke：
     .\node_modules\electron\dist\electron.exe scripts\pcm-transport-smoke.js `
       --mode normal|slow|crash-replace --report .artifacts\pcm-transport\report.json
   验证链路：audio host（loopback）→ MessageChannelMain → pcm-sink utility process。
   - normal：全速消费，期望零丢帧零缺口；
   - slow：消费端按 4 帧/秒授信（实时是 10 帧/秒），期望有丢帧、队列毫秒数
     被 maxQueueMs 限住、消费端观察到 sequence 缺口；
   - crash-replace：消费端收 10 帧后自杀（exit 13），主进程 fork 新 sink 并
     replacePort，期望新 sink 继续收到帧。
   PCM 不经过主进程；主进程只消费低频 metrics 控制消息。 */

const fs = require('node:fs')
const path = require('node:path')
const { MessageChannelMain, app, utilityProcess } = require('electron')
const { AudioHostController } = require('../src/runtime/audio-host/audio-host-controller')

const SINK_PATH = path.join(__dirname, '..', 'src', 'runtime', 'pcm-sink', 'pcm-sink.js')
const FRAME_MS = 100

function parseArguments (argv) {
  const options = { mode: 'normal', report: '.artifacts/pcm-transport/report.json' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--mode') { options.mode = String(value); index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!['normal', 'slow', 'crash-replace'].includes(options.mode)) throw new Error(`unknown mode: ${options.mode}`)
  return options
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** fork sink，配置完成后把 port2 交给它；返回统计与退出观测。 */
async function launchSink (config, port2) {
  const child = utilityProcess.fork(SINK_PATH)
  const observed = { stats: null, exitCode: null }
  child.on('message', (message) => {
    if (message?.type === 'stats') observed.stats = message.stats
  })
  child.on('exit', (code) => { observed.exitCode = code })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sink configure timed out')), 5000)
    child.once('message', (message) => {
      clearTimeout(timer)
      message?.type === 'configured' ? resolve() : reject(new Error('unexpected sink reply'))
    })
    child.postMessage({ type: 'configure', ...config })
  })
  child.postMessage({ type: 'pcm-port' }, [port2])
  return { child, observed }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  /* 宿主窗销毁后禁止 Electron 默认退出——报告与断言在窗口关闭后才执行。 */
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(path.dirname(reportPath), 'electron-user-data'))
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  await app.whenReady()

  const evidence = []
  const hostMetrics = []
  const controlEvents = []
  const controller = new AudioHostController({ onEvidence: (event) => evidence.push(event) })
  controller.onControl((message) => {
    controlEvents.push(message)
    if (message.type === 'metrics' || message.type === 'stopped') hostMetrics.push(message)
  })

  const sessionId = `pcm-smoke-${options.mode}-${Date.now()}`
  const sourceIds = ['loopback']
  const maxQueueMs = 1000
  const sinkConfigs = {
    normal: { sourceIds, initialCredits: 25, creditBatch: 10, consumeDelayMs: 0, crashAfterFrames: 0 },
    slow: { sourceIds, initialCredits: 5, creditBatch: 4, consumeDelayMs: 1000, crashAfterFrames: 0 },
    'crash-replace': { sourceIds, initialCredits: 25, creditBatch: 10, consumeDelayMs: 0, crashAfterFrames: 10 }
  }

  let first = null
  let secondSink = null

  const failures = []
  try {
    const channel = new MessageChannelMain()
    first = await launchSink(sinkConfigs[options.mode], channel.port2)
    await controller.startCapture({ sessionId, sourceIds, maxQueueMs, port: channel.port1 })

    if (options.mode === 'crash-replace') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sink did not crash in time')), 8000)
        first.child.on('exit', () => { clearTimeout(timer); resolve() })
      })
      if (first.observed.exitCode !== 13) failures.push(`first sink exit code ${first.observed.exitCode} != 13`)
      const replacement = new MessageChannelMain()
      secondSink = await launchSink(sinkConfigs.normal, replacement.port2)
      controller.replacePort(replacement.port1)
      await delay(3000)
    } else {
      await delay(options.mode === 'slow' ? 5000 : 4000)
    }

    const stopResult = await controller.stopCapture()
    await delay(700)

    const finalHost = stopResult?.metrics?.loopback || null
    const finalSink = (secondSink || first).observed.stats?.sources?.loopback || null
    if (!finalHost) failures.push('missing final host metrics')
    if (!finalSink) failures.push('missing final sink stats')

    if (finalHost && finalSink) {
      if (options.mode === 'normal') {
        if (finalSink.framesReceived < 30) failures.push(`normal: only ${finalSink.framesReceived} frames received`)
        if (finalSink.sequenceGapCount !== 0) failures.push(`normal: ${finalSink.sequenceGapCount} sequence gaps`)
        if (finalHost.droppedFrames !== 0) failures.push(`normal: ${finalHost.droppedFrames} dropped frames`)
        if (finalHost.lostInFlightFrames !== 0) failures.push(`normal: ${finalHost.lostInFlightFrames} lost in flight`)
      } else if (options.mode === 'slow') {
        if (finalHost.droppedFrames === 0) failures.push('slow: expected dropped frames')
        if (finalHost.maxQueuedMsObserved > maxQueueMs + FRAME_MS) {
          failures.push(`slow: queue exceeded budget (${finalHost.maxQueuedMsObserved}ms)`)
        }
        if (finalSink.sequenceGapCount === 0) failures.push('slow: expected sequence gaps at the sink')
        if (finalSink.framesReceived === 0) failures.push('slow: sink received nothing')
      } else {
        if (finalSink.framesReceived === 0) failures.push('crash-replace: replacement sink received nothing')
        if ((first.observed.stats?.sources?.loopback?.framesReceived || 0) === 0) {
          failures.push('crash-replace: first sink received nothing before crashing')
        }
        /* 发进死端口的帧必须以 lostInFlightFrames 上界可观测（含端口替换计数）。 */
        if ((finalHost.portReplacements || 0) !== 1) failures.push(`crash-replace: portReplacements=${finalHost.portReplacements}`)
        if ((finalHost.lostInFlightFrames || 0) < 1) {
          failures.push('crash-replace: expected lostInFlightFrames >= 1 for frames posted into the dead port')
        }
      }
    }

    const report = {
      schemaVersion: 1,
      kind: 'pcm-transport-smoke',
      mode: options.mode,
      executedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
      result: failures.length === 0 ? 'pass' : 'fail',
      failures,
      finalHostMetrics: finalHost,
      finalSinkStats: finalSink,
      firstSinkStats: first.observed.stats,
      firstSinkExitCode: first.observed.exitCode,
      hostMetricsTimeline: hostMetrics.slice(-10),
      controlEventTypes: controlEvents.map((event) => event.type),
      evidence: evidence.slice(-40)
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      mode: options.mode,
      result: report.result,
      failures,
      host: finalHost && {
        captured: finalHost.capturedFrames,
        sent: finalHost.sentFrames,
        dropped: finalHost.droppedFrames,
        maxQueuedMs: finalHost.maxQueuedMsObserved
      },
      sink: finalSink && {
        received: finalSink.framesReceived,
        gaps: finalSink.sequenceGapCount,
        missed: finalSink.missedFrames
      }
    }) + '\n')
    controller.dispose()
    try { first?.child.kill() } catch { /* already exited */ }
    try { secondSink?.child.kill() } catch { /* already exited */ }
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(error?.stack || error)
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        schemaVersion: 1,
        kind: 'pcm-transport-smoke',
        mode: options.mode,
        result: 'error',
        error: String(error?.message || error).slice(0, 300),
        firstSinkStats: first?.observed?.stats || null,
        firstSinkExitCode: first?.observed?.exitCode ?? null,
        secondSinkStats: secondSink?.observed.stats || null,
        hostMetricsTimeline: hostMetrics.slice(-10),
        controlEventTypes: controlEvents.map((event) => event.type),
        evidence: evidence.slice(-40)
      }, null, 2) + '\n')
    } catch { /* reporting is best effort */ }
    controller.dispose()
    try { first?.child.kill() } catch { /* already exited */ }
    try { secondSink?.child.kill() } catch { /* already exited */ }
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
