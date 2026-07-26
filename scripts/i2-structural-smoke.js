'use strict'

/* I2.1 结构接线实机 smoke：
     .\node_modules\electron\dist\electron.exe scripts\i2-structural-smoke.js `
       --report .artifacts\i2-structural\report.json
   链路：SessionCoordinator（真实状态机）→ RealtimeRuntimeAdapter →
   AudioHostController（loopback 采集）+ MessageChannelMain + realtime worker
   （null recognizer）。
   验证（Gate 0B 未过，全程零字幕、不伪造）：
   - start → listening（真实采集/worker 就绪）
   - 击杀 worker → coordinator error（REALTIME_WORKER_EXITED，可重试）
   - retry → 重新 listening（fresh worker + host）
   - pause → paused，resume → listening
   - stop → idle；全程 CaptionEvent 数量为 0、CaptionState 为空 */

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { RealtimeRuntimeAdapter } = require('../src/runtime/realtime-runtime-adapter')
const { RealtimeWorkerHost } = require('../src/runtime/realtime-worker/worker-host')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../src/main/runtime-options')

function parseArguments (argv) {
  const options = { report: '.artifacts/i2-structural/report.json' }
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

  const workers = []
  const adapters = []
  const phases = []
  const captions = []
  const failures = []
  let coordinator = null
  const expect = (condition, label) => { if (!condition) failures.push(label) }

  try {
    coordinator = new SessionCoordinator({
      adapterFactory: () => {
        const adapter = new RealtimeRuntimeAdapter({
          workerFactory: () => {
            const worker = new RealtimeWorkerHost()
            workers.push(worker)
            return worker
          }
        })
        adapters.push(adapter)
        return adapter
      },
      runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
      configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true },
      idFactory: () => `i2-structural-${Date.now()}`,
      onListenerError: (error) => failures.push(`listener error: ${String(error?.message || error).slice(0, 120)}`)
    })
    coordinator.onSnapshot((snapshot) => phases.push(snapshot.phase))
    coordinator.onCaption((event) => captions.push(event))

    const started = await coordinator.command('start')
    expect(started.ok === true, `start failed: ${started.code}`)
    expect(coordinator.getSnapshot().phase === 'listening', 'not listening after start')
    await delay(3000)

    /* worker 中途死亡 → coordinator 必须自行进入可重试 error。 */
    workers.at(-1).kill()
    await delay(600)
    const faulted = coordinator.getSnapshot()
    expect(faulted.phase === 'error', `expected error after worker kill, got ${faulted.phase}`)
    expect(faulted.lastError?.code === 'REALTIME_WORKER_EXITED', `unexpected fault code ${faulted.lastError?.code}`)
    expect(faulted.capabilities.canRetry === true, 'fault must be retryable')

    const retried = await coordinator.command('retry')
    expect(retried.ok === true, `retry failed: ${retried.code}`)
    expect(coordinator.getSnapshot().phase === 'listening', 'not listening after retry')
    await delay(1500)

    const paused = await coordinator.command('pause')
    expect(paused.ok === true, `pause failed: ${paused.code}`)
    expect(coordinator.getSnapshot().phase === 'paused', 'not paused')
    const resumed = await coordinator.command('resume')
    expect(resumed.ok === true, `resume failed: ${resumed.code}`)
    expect(coordinator.getSnapshot().phase === 'listening', 'not listening after resume')

    const stopped = await coordinator.command('stop')
    expect(stopped.ok === true, `stop failed: ${stopped.code}`)
    expect(coordinator.getSnapshot().phase === 'idle', 'not idle after stop')

    /* 结构模式的诚实性：零字幕。 */
    expect(captions.length === 0, `structural mode must emit no captions, got ${captions.length}`)
    expect(coordinator.getCaptionState().segments.length === 0, 'caption state must stay empty')
    expect(workers.length === 2, `expected 2 workers (initial + retry), got ${workers.length}`)

    const report = {
      schemaVersion: 1,
      kind: 'i2-structural-smoke',
      executedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, node: process.versions.node },
      result: failures.length === 0 ? 'pass' : 'fail',
      failures,
      phases,
      captionCount: captions.length,
      workerCount: workers.length,
      workerStats: workers.map((worker) => worker.lastStats?.sources?.loopback || null)
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ result: report.result, failures, phases }) + '\n')
    await coordinator.dispose()
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(error?.stack || error)
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        schemaVersion: 1,
        kind: 'i2-structural-smoke',
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
