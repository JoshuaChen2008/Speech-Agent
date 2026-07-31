'use strict'

// @ts-check

/* Exact-child Electron supervisor.
   -------------------------------------------------------------------------
   The spawned ChildProcess object is the only process identity used here.
   There is no process-name enumeration, PID persistence, debugger, Crashpad,
   WER configuration, stdout/stderr capture or upload. The child sends only
   the strict IPC protocol from electron-exit-evidence.js; this parent is the
   sole writer so it can finalize evidence after a native main-process exit.

   Persistence is deliberately fail-open unless strictReport is explicitly
   enabled. A persistence fault never changes the lifetime of a spawned
   Electron child. Each launch writes an independent current report; only a
   completed primary run or an abnormal exit may replace the canonical report. */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const {
  createEvidenceAccumulator,
  validateEvidenceReport
} = require('../src/main/services/electron-exit-evidence')

const DEFAULT_IPC_DRAIN_TIMEOUT_MS = 500

function positiveElectronMajor (value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 999) {
    throw new TypeError('invalid Electron major')
  }
  return parsed
}

function parseArguments (argv) {
  const options = {
    reportPath: null,
    entryPath: '.',
    executablePath: null,
    electronMajor: null,
    entryArguments: [],
    strictReport: false,
    packaged: false
  }
  const single = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--strict-report' || flag === '--packaged') {
      if (single.has(flag)) throw new TypeError('duplicate supervisor argument')
      single.add(flag)
      if (flag === '--strict-report') options.strictReport = true
      if (flag === '--packaged') options.packaged = true
      continue
    }
    if (!['--report', '--entry', '--electron', '--electron-major', '--entry-arg'].includes(flag) ||
        index + 1 >= argv.length) {
      throw new TypeError('invalid supervisor arguments')
    }
    const value = argv[++index]
    if (flag === '--entry-arg') {
      options.entryArguments.push(String(value))
      continue
    }
    if (single.has(flag)) throw new TypeError('duplicate supervisor argument')
    single.add(flag)
    if (flag === '--report') options.reportPath = String(value)
    if (flag === '--entry') options.entryPath = String(value)
    if (flag === '--electron') options.executablePath = String(value)
    if (flag === '--electron-major') options.electronMajor = positiveElectronMajor(value)
  }
  if (options.packaged && (!options.executablePath || options.electronMajor === null || single.has('--entry'))) {
    throw new TypeError('packaged supervision requires --electron and --electron-major without --entry')
  }
  return options
}

/**
 * Per-user default for a future `npm start` wiring. It creates no registry or
 * system configuration and the resulting absolute address is never serialized
 * into evidence. Callers may still pass an isolated --report in CI.
 */
function defaultReportPath (options = {}) {
  const platform = options.platform || process.platform
  const environment = options.environment || process.env
  const homeDirectory = options.homeDirectory || os.homedir()
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      typeof homeDirectory !== 'string' || !path.isAbsolute(homeDirectory) ||
      path.resolve(homeDirectory) === path.parse(path.resolve(homeDirectory)).root) {
    throw new TypeError('invalid default evidence directory inputs')
  }
  const absoluteEnvironmentValue = (name) => {
    const value = environment[name]
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null
    const resolved = path.resolve(value)
    return resolved === path.parse(resolved).root ? null : resolved
  }
  let base
  if (platform === 'win32') {
    base = absoluteEnvironmentValue('LOCALAPPDATA') || absoluteEnvironmentValue('APPDATA') ||
      path.join(path.resolve(homeDirectory), 'AppData', 'Local')
  } else if (platform === 'darwin') {
    base = path.join(path.resolve(homeDirectory), 'Library', 'Application Support')
  } else {
    base = absoluteEnvironmentValue('XDG_STATE_HOME') ||
      path.join(path.resolve(homeDirectory), '.local', 'state')
  }
  return path.join(base, 'live-subtitle-agent', 'diagnostics', 'last-exit-evidence.json')
}

function defaultLastAbnormalReportPath (reportPath = defaultReportPath()) {
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    throw new TypeError('reportPath is required')
  }
  const canonical = path.resolve(reportPath)
  return path.join(path.dirname(canonical), 'last-abnormal-exit-evidence.json')
}

function defaultElectronRuntime () {
  const executablePath = require('electron')
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new TypeError('Electron executable is unavailable')
  }
  const version = require('electron/package.json').version
  return { executablePath, electronMajor: positiveElectronMajor(String(version).split('.')[0]) }
}

function writeReportAtomic (reportPath, report) {
  validateEvidenceReport(report)
  const target = path.resolve(reportPath)
  const directory = path.dirname(target)
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`)
  fs.mkdirSync(directory, { recursive: true })
  let descriptor = null
  let renamed = false
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, target)
    renamed = true
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    if (!renamed && fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function currentReportPath (reportPath, identifier = randomUUID()) {
  if (typeof reportPath !== 'string' || reportPath.length === 0 ||
      typeof identifier !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(identifier)) {
    throw new TypeError('invalid current report inputs')
  }
  const canonical = path.resolve(reportPath)
  return path.join(
    path.dirname(canonical),
    `.${path.basename(canonical)}.${identifier}.current`
  )
}

function shouldPromoteCanonical (report) {
  validateEvidenceReport(report)
  if (report.outcome === 'abnormal-exit') return true
  return report.outcome === 'clean-exit' && report.lifecycle.bootstrapComplete
}

function persistenceError () {
  const error = new Error('Electron evidence persistence failed.')
  error.code = 'E_ELECTRON_EVIDENCE_PERSISTENCE'
  return error
}

function safeEntryArguments (value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError('entryArguments must be strings')
  }
  return [...value]
}

async function superviseElectron (options = {}) {
  if (typeof options.reportPath !== 'string' || options.reportPath.length === 0 ||
      typeof options.executablePath !== 'string' || options.executablePath.length === 0) {
    throw new TypeError('executablePath and reportPath are required')
  }
  if (options.packaged !== undefined && typeof options.packaged !== 'boolean') {
    throw new TypeError('packaged must be boolean')
  }
  const packaged = options.packaged === true
  if (!packaged && (typeof options.entryPath !== 'string' || options.entryPath.length === 0)) {
    throw new TypeError('entryPath is required for an unpackaged Electron launch')
  }
  const entryArguments = safeEntryArguments(options.entryArguments)
  if (options.strictReport !== undefined && typeof options.strictReport !== 'boolean') {
    throw new TypeError('strictReport must be boolean')
  }
  if (options.lastAbnormalReportPath !== undefined && options.lastAbnormalReportPath !== null &&
      (typeof options.lastAbnormalReportPath !== 'string' || options.lastAbnormalReportPath.length === 0)) {
    throw new TypeError('lastAbnormalReportPath must be null or a path')
  }
  if (options.reportWriter !== undefined && typeof options.reportWriter !== 'function') {
    throw new TypeError('reportWriter must be a function')
  }
  if (options.spawnProcess !== undefined && typeof options.spawnProcess !== 'function') {
    throw new TypeError('spawnProcess must be a function')
  }
  const ipcDrainTimeoutMs = options.ipcDrainTimeoutMs === undefined
    ? DEFAULT_IPC_DRAIN_TIMEOUT_MS
    : options.ipcDrainTimeoutMs
  if (!Number.isSafeInteger(ipcDrainTimeoutMs) || ipcDrainTimeoutMs < 0 || ipcDrainTimeoutMs > 5000) {
    throw new TypeError('ipcDrainTimeoutMs must be an integer from 0 to 5000')
  }
  const accumulator = createEvidenceAccumulator({
    electronMajor: options.electronMajor ?? null,
    platform: options.platform || process.platform,
    packagedRuntime: packaged,
    now: options.now
  })
  const strictReport = options.strictReport === true
  const reportPath = path.resolve(options.reportPath)
  const lastAbnormalReportPath = options.lastAbnormalReportPath
    ? path.resolve(options.lastAbnormalReportPath)
    : null
  if (lastAbnormalReportPath === reportPath) {
    throw new TypeError('canonical and last-abnormal reports must be distinct')
  }
  const activeReportPath = currentReportPath(reportPath)
  const reportWriter = options.reportWriter || writeReportAtomic
  const spawnProcess = options.spawnProcess || spawn
  const executablePath = path.resolve(options.executablePath)
  const entryPath = packaged ? null : path.resolve(options.entryPath)
  const workingDirectory = options.cwd === undefined ? process.cwd() : path.resolve(options.cwd)
  if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env))) {
    throw new TypeError('env must be an object')
  }
  const environment = options.env === undefined ? process.env : options.env

  let persistenceFailed = false
  let warningWritten = false
  const warnPersistenceFailure = () => {
    persistenceFailed = true
    if (warningWritten) return
    warningWritten = true
    try {
      process.stderr.write('Electron evidence persistence unavailable; application will continue.\n')
    } catch {
      /* Warning output is also diagnostic-only. */
    }
  }
  const writeCurrentOrCanonical = (target, report) => {
    try {
      reportWriter(target, report)
      return true
    } catch {
      warnPersistenceFailure()
      return false
    }
  }
  const cleanupCurrent = (recordFailure = true) => {
    try {
      fs.unlinkSync(activeReportPath)
    } catch (error) {
      if (error?.code !== 'ENOENT' && recordFailure) warnPersistenceFailure()
    }
  }

  try {
    reportWriter(activeReportPath, accumulator.snapshot())
  } catch {
    if (strictReport) {
      cleanupCurrent(false)
      throw persistenceError()
    }
    warnPersistenceFailure()
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    let spawnObserved = false
    let exitObserved = false
    let exitCode = null
    let exitSignalObserved = false
    let ipcDisconnected = false
    let ipcDrainTimer = null
    let child

    const finish = (action) => {
      if (settled) return
      settled = true
      if (ipcDrainTimer !== null) clearTimeout(ipcDrainTimer)
      try {
        action()
        const report = accumulator.snapshot()
        writeCurrentOrCanonical(activeReportPath, report)
        if (shouldPromoteCanonical(report)) {
          writeCurrentOrCanonical(reportPath, report)
          if (report.outcome === 'abnormal-exit' && lastAbnormalReportPath) {
            writeCurrentOrCanonical(lastAbnormalReportPath, report)
          }
        }
        cleanupCurrent()
        if (strictReport && persistenceFailed) reject(persistenceError())
        else resolve(report)
      } catch (error) {
        cleanupCurrent()
        reject(error)
      }
    }

    const finishObservedExit = () => {
      finish(() => accumulator.finishMainExit(exitCode, exitSignalObserved))
    }

    const scheduleExitFinish = () => {
      if (settled || !exitObserved) return
      if (ipcDisconnected) {
        setImmediate(finishObservedExit)
        return
      }
      if (ipcDrainTimer === null) {
        ipcDrainTimer = setTimeout(finishObservedExit, ipcDrainTimeoutMs)
      }
    }

    try {
      child = spawnProcess(executablePath, packaged ? entryArguments : [entryPath, ...entryArguments], {
        cwd: workingDirectory,
        env: environment,
        windowsHide: true,
        detached: false,
        /* stdout/stderr stay visible to the developer but are never captured
           or written by the evidence supervisor. */
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
    } catch {
      finish(() => accumulator.failMainLaunch())
      return
    }

    child.once('spawn', () => {
      if (settled) return
      spawnObserved = true
      accumulator.markMainSpawned()
      writeCurrentOrCanonical(activeReportPath, accumulator.snapshot())
    })

    child.on('message', (value) => {
      if (settled) return
      accumulator.acceptIpcMessage(value)
      writeCurrentOrCanonical(activeReportPath, accumulator.snapshot())
    })

    child.once('error', () => {
      if (!spawnObserved) finish(() => accumulator.failMainLaunch())
    })
    child.once('exit', (code, signal) => {
      exitObserved = true
      exitCode = code
      exitSignalObserved = signal !== null
      scheduleExitFinish()
    })
    child.once('disconnect', () => {
      ipcDisconnected = true
      scheduleExitFinish()
    })
    child.once('close', (code, signal) => {
      if (settled) return
      ipcDisconnected = true
      if (spawnObserved) {
        if (!exitObserved) {
          exitObserved = true
          exitCode = code
          exitSignalObserved = signal !== null
        }
        scheduleExitFinish()
      } else {
        finish(() => accumulator.failMainLaunch())
      }
    })
  })
}

async function runCli () {
  const parsed = parseArguments(process.argv.slice(2))
  let runtime
  if (parsed.executablePath) {
    runtime = {
      executablePath: parsed.executablePath,
      electronMajor: parsed.electronMajor
    }
  } else {
    runtime = defaultElectronRuntime()
    if (parsed.electronMajor !== null) runtime.electronMajor = parsed.electronMajor
  }
  const reportPath = parsed.reportPath || defaultReportPath()
  const report = await superviseElectron({
    executablePath: runtime.executablePath,
    electronMajor: runtime.electronMajor,
    entryPath: parsed.entryPath,
    entryArguments: parsed.entryArguments,
    packaged: parsed.packaged,
    reportPath,
    lastAbnormalReportPath: defaultLastAbnormalReportPath(reportPath),
    strictReport: parsed.strictReport
  })
  process.stdout.write(JSON.stringify({
    outcome: report.outcome,
    breakpointObserved: report.attribution.breakpointObserved,
    role: report.attribution.role,
    incidentCount: report.counters.incidentCount
  }) + '\n')
  process.exitCode = report.outcome === 'clean-exit' ? 0 : 1
}

if (require.main === module) {
  runCli().catch(() => {
    process.stderr.write('Electron supervision failed.\n')
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_IPC_DRAIN_TIMEOUT_MS,
  defaultElectronRuntime,
  defaultLastAbnormalReportPath,
  defaultReportPath,
  currentReportPath,
  parseArguments,
  shouldPromoteCanonical,
  superviseElectron,
  writeReportAtomic
}
