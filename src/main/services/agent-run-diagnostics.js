'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { performance } = require('node:perf_hooks')
const { BUDGET_AXES } = require('../../agent/contracts/budget-axes')
const sessionSummary = require('../../agent/contracts/session-summary-run-ui')
const { writeAtomic: defaultWriteAtomic } = require('../../agent/formal-run/agent-interaction-exporter')
const {
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_SCHEMA_VERSION,
  METRIC_UNITS,
  assertDiagnosticExportSnapshot,
  assertDiagnosticRecord
} = require('../../agent/contracts/agent-run-diagnostics')

const MAX_FILES = 5
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BUFFERED_RECORDS = 256
const MAX_RECORD_BYTES = 2 * 1024
const FILE_NAME = /^agent-run-diagnostics-(\d{12})\.jsonl$/

function digest (value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function isDigest (value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function nullableInteger (value) {
  return value === null || Number.isSafeInteger(value) && value >= 0
}

function exactObject (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validInput (input) {
  return exactObject(input, [
    'requestId', 'requestDigest', 'runId', 'attempt', 'phase', 'event', 'elapsedMs',
    'lastActivityAgeMs', 'errorCode', 'budgetAxis', 'metrics', 'modelBindingDigest', 'planDigest'
  ]) && typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 512 &&
    (input.requestDigest === null || isDigest(input.requestDigest)) &&
    (input.runId === null || typeof input.runId === 'string' && input.runId.length > 0 && input.runId.length <= 512) &&
    Number.isSafeInteger(input.attempt) && input.attempt >= 0 && sessionSummary.PHASES.includes(input.phase) &&
    DIAGNOSTIC_EVENTS.includes(input.event) && nullableInteger(input.elapsedMs) &&
    nullableInteger(input.lastActivityAgeMs) &&
    (input.errorCode === null || sessionSummary.ERROR_CODES.includes(input.errorCode)) &&
    (input.budgetAxis === null || BUDGET_AXES.includes(input.budgetAxis)) &&
    exactObject(input.metrics, ['actual', 'limit', 'unit']) && nullableInteger(input.metrics.actual) &&
    nullableInteger(input.metrics.limit) && (input.metrics.actual === null) === (input.metrics.limit === null) &&
    (input.metrics.unit === null || METRIC_UNITS.includes(input.metrics.unit)) &&
    (input.metrics.actual !== null || input.metrics.unit === null) &&
    (input.modelBindingDigest === null || isDigest(input.modelBindingDigest)) &&
    (input.planDigest === null || isDigest(input.planDigest))
}

function buildRecord (input, appVersion, sequence) {
  if (!validInput(input)) return null
  const record = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    appVersion,
    requestDigest: input.requestDigest,
    runDigest: input.runId === null ? null : digest(input.runId),
    attempt: input.attempt,
    sequence,
    phase: input.phase,
    event: input.event,
    elapsedMs: input.elapsedMs,
    lastActivityAgeMs: input.lastActivityAgeMs,
    errorCode: input.errorCode,
    budgetAxis: input.budgetAxis,
    metrics: { ...input.metrics },
    modelBindingDigest: input.modelBindingDigest,
    planDigest: input.planDigest
  }
  try { assertDiagnosticRecord(record) } catch { return null }
  return record
}

function makeFileName (sequence) {
  return `agent-run-diagnostics-${String(sequence).padStart(12, '0')}.jsonl`
}

class AgentRunDiagnostics {
  constructor (options = {}) {
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
      throw new TypeError('diagnostic directory must be absolute')
    }
    if (typeof options.appVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(options.appVersion)) {
      throw new TypeError('diagnostic app version is invalid')
    }
    this.directory = path.resolve(options.directory)
    this.appVersion = options.appVersion
    this.fs = options.fsApi || fs.promises
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.defer = typeof options.defer === 'function' ? options.defer : (callback) => setImmediate(callback)
    this.onAvailabilityChanged = typeof options.onAvailabilityChanged === 'function' ? options.onAvailabilityChanged : () => {}
    this.state = 'initializing'
    this.failureCode = null
    this.sequence = 0
    this.fileSequence = 0
    this.files = []
    this.currentFile = null
    this.pending = []
    this.flushTask = null
    this.initialization = this.initialize()
  }

  getStatus () {
    return Object.freeze({
      available: this.state === 'available',
      state: this.state,
      errorCode: this.failureCode
    })
  }

  notifyAvailability () {
    const status = this.getStatus()
    try { this.onAvailabilityChanged(status) } catch { /* diagnostics status cannot affect product work */ }
  }

  markUnavailable (code) {
    if (this.state === 'unavailable') return
    this.state = 'unavailable'
    this.failureCode = 'AGENT_DIAGNOSTICS_UNAVAILABLE'
    this.notifyAvailability()
  }

  async initialize () {
    try {
      await this.fs.mkdir(this.directory, { recursive: true })
      const directoryStats = await this.fs.lstat(this.directory)
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new Error('invalid diagnostic directory')
      await this.refreshFiles()
      await this.cleanRetention()
      await this.restoreSequence()
      if (this.state === 'unavailable') return false
      this.state = 'available'
      this.failureCode = null
      this.notifyAvailability()
      if (this.pending.length > 0) this.scheduleFlush()
      return true
    } catch {
      this.markUnavailable('initialize_failed')
      return false
    }
  }

  record (input) {
    if (this.state === 'unavailable') return false
    if (this.pending.length >= MAX_BUFFERED_RECORDS) {
      this.markUnavailable('buffer_full')
      return false
    }
    const nextSequence = this.sequence + 1
    const record = buildRecord(input, this.appVersion, nextSequence)
    if (!record) return false
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return false
    this.sequence = nextSequence
    this.pending.push(line)
    if (this.state === 'available') this.scheduleFlush()
    return true
  }

  scheduleFlush () {
    if (this.state !== 'available' || this.flushTask || this.pending.length === 0) return
    this.flushTask = Promise.resolve(this.initialization).then(async (initialized) => {
      if (!initialized || this.state !== 'available') return false
      while (this.pending.length > 0 && this.state === 'available') {
        const line = this.pending[0]
        await this.writeLine(line)
        this.pending.shift()
      }
      return this.state === 'available'
    }).catch(() => {
      this.markUnavailable('write_failed')
      return false
    }).finally(() => {
      this.flushTask = null
      if (this.pending.length > 0 && this.state === 'available') this.scheduleFlush()
    })
  }

  async drain () {
    await this.initialization
    if (this.state === 'available') this.scheduleFlush()
    if (this.flushTask) await this.flushTask
    return this.state === 'available' && this.pending.length === 0
  }

  async refreshFiles () {
    const entries = await this.fs.readdir(this.directory, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const match = FILE_NAME.exec(entry.name)
      if (!match) continue
      const filePath = path.join(this.directory, entry.name)
      const stats = await this.fs.lstat(filePath)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        await this.fs.unlink(filePath)
        continue
      }
      files.push({
        sequence: Number(match[1]),
        path: filePath,
        size: stats.size,
        createdAtMs: Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs
      })
    }
    files.sort((left, right) => left.sequence - right.sequence)
    this.files = files
    this.fileSequence = Math.max(this.fileSequence, ...files.map((file) => file.sequence), 0)
    this.currentFile = files.at(-1) || null
  }

  async cleanRetention () {
    const cutoff = this.now() - MAX_FILE_AGE_MS
    for (const file of [...this.files]) {
      if (file.createdAtMs <= cutoff || file.size > MAX_FILE_BYTES) {
        await this.fs.unlink(file.path)
        this.files = this.files.filter((item) => item.path !== file.path)
      }
    }
    while (this.files.length > MAX_FILES) {
      const oldest = this.files.shift()
      await this.fs.unlink(oldest.path)
    }
    this.currentFile = this.files.at(-1) || null
  }

  async restoreSequence () {
    let maximum = this.sequence
    for (const file of this.files) {
      // The file stream is observational only; malformed or partial lines never
      // reconstruct task state and are ignored for the sequence high-water mark.
      const input = fs.createReadStream(file.path, { encoding: 'utf8' })
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
        if (!line) continue
        try {
          const record = assertDiagnosticRecord(JSON.parse(line))
          maximum = Math.max(maximum, record.sequence)
        } catch { /* ignore malformed historical diagnostic lines */ }
        }
      } finally {
        lines.close()
        input.destroy()
      }
    }
    this.sequence = maximum
  }

  async allocateFile () {
    await this.cleanRetention()
    while (this.files.length >= MAX_FILES) {
      const oldest = this.files.shift()
      if (this.currentFile?.path === oldest.path) this.currentFile = null
      await this.fs.unlink(oldest.path)
    }
    for (let collisions = 0; collisions < 32; collisions += 1) {
      const sequence = ++this.fileSequence
      const filePath = path.join(this.directory, makeFileName(sequence))
      try {
        const handle = await this.fs.open(filePath, 'wx', 0o600)
        await handle.close()
        const file = { sequence, path: filePath, size: 0, createdAtMs: this.now() }
        this.files.push(file)
        this.currentFile = file
        return file
      } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('diagnostic file sequence is exhausted')
  }

  async writeLine (line) {
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_RECORD_BYTES) throw new Error('diagnostic record exceeded limit')
    // Enforce the age bound during normal writes as well as startup/rotation.
    // Otherwise a quiet current file could keep older files beyond retention.
    await this.cleanRetention()
    let file = this.currentFile
    if (file) {
      const stats = await this.fs.stat(file.path)
      file.size = stats.size
    }
    if (!file || file.size + bytes > MAX_FILE_BYTES) file = await this.allocateFile()
    await this.fs.appendFile(file.path, line, { encoding: 'utf8' })
    file.size += bytes
  }

  async recordsForRequestDigest (requestDigest) {
    if (!isDigest(requestDigest)) throw new TypeError('diagnostic request digest is invalid')
    await this.initialization
    if (this.state === 'available') await this.drain()
    const maximumSequence = this.sequence
    const found = []
    try {
      for (const file of [...this.files]) {
        const stats = await this.fs.lstat(file.path)
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) {
          throw new Error('diagnostic file is unavailable')
        }
        const content = await this.fs.readFile(file.path, 'utf8')
        for (const line of String(content).split(/\r?\n/u)) {
          if (!line) continue
          try {
            const record = assertDiagnosticRecord(JSON.parse(line))
            if (record.requestDigest === requestDigest && record.sequence <= maximumSequence) found.push(record)
          } catch { /* malformed or partial log lines are not exportable */ }
        }
      }
    } catch {
      this.markUnavailable('read_failed')
      const error = new Error('AGENT_DIAGNOSTICS_UNAVAILABLE')
      error.code = 'AGENT_DIAGNOSTICS_UNAVAILABLE'
      throw error
    }
    found.sort((left, right) => left.sequence - right.sequence)
    return { available: this.state === 'available', records: found }
  }

  async queryRequest ({ requestDigest, beforeSequence = null, limit = 50 } = {}) {
    if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
      throw new TypeError('diagnostic sequence cursor is invalid')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('diagnostic page size is invalid')
    const all = await this.recordsForRequestDigest(requestDigest)
    const eligible = all.records.filter((record) => beforeSequence === null || record.sequence < beforeSequence)
    const descending = eligible.slice(-limit).reverse()
    const hasMore = eligible.length > descending.length
    return {
      available: all.available,
      records: descending,
      nextBeforeSequence: hasMore ? descending[descending.length - 1].sequence : null
    }
  }

  async exportRequest ({ requestDigest, ownerWindow = null, showSaveDialog, writeAtomic = defaultWriteAtomic } = {}) {
    if (typeof showSaveDialog !== 'function') throw new TypeError('diagnostic save dialog is required')
    if (typeof writeAtomic !== 'function') throw new TypeError('atomic diagnostic writer is required')
    const loaded = await this.recordsForRequestDigest(requestDigest)
    const snapshot = assertDiagnosticExportSnapshot({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      available: loaded.available,
      records: loaded.records
    })
    const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    const dialogResult = await showSaveDialog(ownerWindow, {
      title: '导出 Agent 运行诊断',
      defaultPath: `agent-run-diagnostics-${requestDigest.slice(0, 16)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (!dialogResult || dialogResult.canceled === true || typeof dialogResult.filePath !== 'string' || dialogResult.filePath.length === 0) {
      return { status: 'cancelled', recordCount: 0, available: loaded.available }
    }
    try {
      await writeAtomic(dialogResult.filePath, bytes)
    } catch {
      const error = new Error('AGENT_DIAGNOSTIC_EXPORT_FAILED')
      error.code = 'AGENT_DIAGNOSTIC_EXPORT_FAILED'
      throw error
    }
    return { status: 'saved', recordCount: snapshot.records.length, available: snapshot.available }
  }
}

module.exports = Object.freeze({
  AgentRunDiagnostics,
  MAX_BUFFERED_RECORDS,
  MAX_FILE_AGE_MS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_RECORD_BYTES,
  defaultWriteAtomic
})
