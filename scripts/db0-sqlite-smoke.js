'use strict'

/* 安全运行方式（PowerShell）：
   Start-Process -FilePath .\\node_modules\\electron\\dist\\electron.exe `
     -ArgumentList 'scripts/db0-sqlite-smoke.js','--report','docs/validation/db0-sqlite-development-results.json','--work-dir','.artifacts/db0-live' `
     -Wait -PassThru -WindowStyle Hidden

   无 BrowserWindow；数据库只位于隔离 smoke userData；主进程等待 utility
   worker 确认关闭并自然退出。报告不包含数据库绝对路径或用户正文。 */

const fs = require('node:fs')
const path = require('node:path')
const { app, utilityProcess } = require('electron')

const WORKER_PATH = path.join(__dirname, '..', 'src', 'runtime', 'storage-worker', 'storage-worker.js')
const PROTOCOL_VERSION = 1

function parseArguments (argv) {
  const options = {
    report: 'docs/validation/db0-sqlite-development-results.json',
    workDir: '.artifacts/db0-live'
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--report', '--work-dir'].includes(flag) || seen.has(flag) || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${flag}`)
    }
    seen.add(flag)
    const value = argv[index + 1]
    if (flag === '--report') options.report = value
    else options.workDir = value
    index += 1
  }
  return options
}

function request (child, operation, requestId, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${operation} timed out`))
    }, timeoutMs)
    const onMessage = (message) => {
      if (message?.type !== 'storage:response' || message.requestId !== requestId) return
      cleanup()
      if (message.ok) resolve(message.result)
      else reject(new Error(`${message.error?.code || 'STORAGE_ERROR'}: ${message.error?.message || 'unknown error'}`))
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`storage worker exited during ${operation} (code ${code})`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('message', onMessage)
      child.removeListener('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.postMessage({ version: PROTOCOL_VERSION, type: 'storage:request', requestId, operation, payload })
  })
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  const workDir = path.resolve(options.workDir, `run-${Date.now()}`)
  const userData = path.join(workDir, 'electron-user-data')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.on('window-all-closed', () => {})
  await app.whenReady()

  const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'Speech Agent DB0 storage qualification' })
  let exitCode = null
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => {
      exitCode = code
      resolve(code)
    })
  })

  try {
    const qualification = await request(child, 'db0:qualify', 'db0-qualify-1', {
      databasePath: path.join(userData, 'data', 'speech-agent.sqlite3')
    })
    await request(child, 'storage:shutdown', 'db0-shutdown-1')
    const workerExitCode = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))
    ])
    if (workerExitCode === 'timeout') throw new Error('storage worker did not exit after shutdown acknowledgement')
    if (workerExitCode !== 0) throw new Error(`storage worker exit code ${workerExitCode}`)

    const report = {
      schemaVersion: 1,
      kind: 'db0-sqlite-development-qualification',
      executedAt: new Date().toISOString(),
      result: qualification.status,
      gateStatus: 'partial',
      development: qualification,
      packaged: {
        status: 'pending',
        gate: 'B5/I4 packaged ASAR/NSIS qualification'
      },
      process: {
        workerExitCode,
        noBrowserWindowCreated: true,
        isolatedUserData: true,
        reportContainsTranscriptText: false,
        reportContainsAbsolutePath: false
      }
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      result: report.result,
      gateStatus: report.gateStatus,
      runtime: qualification.runtime,
      failedChecks: qualification.failedChecks,
      workerExitCode
    }) + '\n')
    app.exit(report.result === 'pass' ? 0 : 1)
  } catch (error) {
    try { child.kill() } catch { /* exact disposable utility child */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))])
    const report = {
      schemaVersion: 1,
      kind: 'db0-sqlite-development-qualification',
      executedAt: new Date().toISOString(),
      result: 'error',
      gateStatus: 'partial',
      error: String(error?.message || error).slice(0, 300),
      packaged: { status: 'pending', gate: 'B5/I4 packaged ASAR/NSIS qualification' },
      process: { workerExitCode: exitCode, noBrowserWindowCreated: true, isolatedUserData: true }
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.error(error?.stack || error)
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
