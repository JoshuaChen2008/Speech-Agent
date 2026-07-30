'use strict'

/* B2.1 产品 audio host 的实机 smoke：
   .\node_modules\electron\dist\electron.exe scripts\audio-host-smoke.js `
       --source loopback --duration-ms 2600 `
       --report .artifacts\audio-host\report.json
   跑的是 src/runtime/audio-host/ 的产品控制器，不是 Gate 0C spike。
   只写结构化指标报告，绝不保存现场音频；报告不含绝对路径与设备标签。 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')
const { AudioHostController } = require('../src/runtime/audio-host/audio-host-controller')

function parseArguments (argv) {
  const options = {
    source: 'loopback',
    durationMs: 2600,
    report: '.artifacts/audio-host/report.json'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--source') { options.source = String(value); index += 1 } else if (argv[index] === '--duration-ms') { options.durationMs = Number(value); index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return options
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  const reportDir = path.dirname(reportPath)
  fs.mkdirSync(reportDir, { recursive: true })
  /* 宿主窗销毁后禁止 Electron 默认退出——报告写入在窗口关闭之后。 */
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(reportDir, 'electron-user-data'))
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  await app.whenReady()

  const evidence = []
  const controller = new AudioHostController({ onEvidence: (event) => evidence.push(event) })
  try {
    const outcome = await controller.runDiagnosticCapture({
      sessionId: `audio-host-smoke-${Date.now()}`,
      sourceIds: [options.source],
      durationMs: options.durationMs
    })
    const report = {
      schemaVersion: 1,
      kind: 'audio-host-smoke',
      executedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        osRelease: os.release(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node
      },
      outcome,
      evidence
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      result: outcome.result,
      hostRemainedHidden: outcome.hostRemainedHidden,
      sources: Object.fromEntries(Object.entries(outcome.sources).map(([sourceId, source]) => [
        sourceId,
        {
          status: source.status,
          pass: source.diagnostic?.checks?.pass ?? false,
          signalObserved: source.diagnostic?.checks?.signalObserved ?? null,
          frameCount: source.diagnostic?.pipeline?.frameCount ?? null,
          firstFrameLatencyMs: source.diagnostic?.pipeline?.firstFrameLatencyMs ?? null
        }
      ]))
    }) + '\n')
    controller.dispose()
    app.exit(outcome.result === 'pass' ? 0 : 1)
  } catch (error) {
    console.error(error?.stack || error)
    controller.dispose()
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
