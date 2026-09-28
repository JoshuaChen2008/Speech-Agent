'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { assertDiagnosticRecord, assertDiagnosticExportSnapshot } = require('../../src/agent/contracts/agent-run-diagnostics')
const {
  AgentRunDiagnostics,
  MAX_BUFFERED_RECORDS,
  MAX_FILE_AGE_MS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_RECORD_BYTES
} = require('../../src/main/services/agent-run-diagnostics')

function input (overrides = {}) {
  return {
    requestId: 'request.private-request-marker',
    requestDigest: 'a'.repeat(64),
    runId: 'run.private-run-marker',
    attempt: 1,
    phase: 'waiting_model',
    event: 'model_request_started',
    elapsedMs: 42,
    lastActivityAgeMs: 0,
    errorCode: null,
    budgetAxis: null,
    metrics: { actual: null, limit: null, unit: null },
    modelBindingDigest: 'c'.repeat(64),
    planDigest: null,
    ...overrides
  }
}

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-run-diagnostics-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function readRecords (directory) {
  const files = (await fs.readdir(directory)).filter((name) => /^agent-run-diagnostics-\d{12}\.jsonl$/.test(name))
  const records = []
  for (const name of files) {
    const contents = await fs.readFile(path.join(directory, name), 'utf8')
    for (const line of contents.split('\n')) if (line) records.push(JSON.parse(line))
  }
  return { files, records }
}

test('SEM-F40/J30-DIAG: main diagnostic store persists digests and rejects free-form fields', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'logs', 'diagnostics')
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0' })
  await diagnostics.initialization
  assert.equal(diagnostics.getStatus().available, true)

  assert.equal(diagnostics.record(input()), true)
  assert.equal(diagnostics.record(input({ sequence: 999, subtitle: 'caption private marker' })), false)
  assert.equal(await diagnostics.drain(), true)
  const { files, records } = await readRecords(directory)
  assert.equal(files.length, 1)
  assert.equal(records.length, 1)
  assertDiagnosticRecord(records[0])
  assert.equal(records[0].sequence, 1)
  assert.equal(records[0].requestDigest, 'a'.repeat(64))
  assert.equal(records[0].runDigest, crypto.createHash('sha256').update('run.private-run-marker').digest('hex'))
  const bytes = (await fs.readFile(path.join(directory, files[0]))).toString('utf8')
  assert.equal(bytes.includes('private-request-marker'), false)
  assert.equal(bytes.includes('private-run-marker'), false)
  assert.equal(bytes.includes('caption private marker'), false)
  assert.equal(bytes.includes(root), false)
  assert.ok(Buffer.byteLength(bytes.split('\n')[0] + '\n', 'utf8') <= MAX_RECORD_BYTES)
})

test('SEM-F40/J30-DIAG: request queries page newest-first and export writes a validated atomic snapshot', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  const requestId = 'request.private-export-marker'
  const requestDigest = crypto.createHash('sha256').update(requestId, 'utf8').digest('hex')
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0' })
  await diagnostics.initialization
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    assert.equal(diagnostics.record(input({ requestId, requestDigest, elapsedMs: sequence })), true)
  }

  const firstPage = await diagnostics.queryRequest({ requestDigest, limit: 2 })
  assert.equal(firstPage.available, true)
  assert.deepEqual(firstPage.records.map((item) => item.sequence), [4, 3])
  assert.equal(firstPage.nextBeforeSequence, 3)
  const secondPage = await diagnostics.queryRequest({ requestDigest, beforeSequence: firstPage.nextBeforeSequence, limit: 2 })
  assert.deepEqual(secondPage.records.map((item) => item.sequence), [2, 1])
  assert.equal(secondPage.nextBeforeSequence, null)

  const outputPath = path.join(root, 'chosen-diagnostics.json')
  let saveDialogRequest = null
  const saved = await diagnostics.exportRequest({
    requestDigest,
    ownerWindow: { id: 7 },
    showSaveDialog: async (ownerWindow, options) => {
      saveDialogRequest = { ownerWindow, options }
      return { canceled: false, filePath: outputPath }
    }
  })
  assert.deepEqual(saved, { status: 'saved', recordCount: 4, available: true })
  assert.equal(saveDialogRequest.ownerWindow.id, 7)
  assert.equal(saveDialogRequest.options.title, '导出 Agent 运行诊断')
  const snapshot = assertDiagnosticExportSnapshot(JSON.parse(await fs.readFile(outputPath, 'utf8')))
  assert.deepEqual(snapshot.records.map((item) => item.sequence), [1, 2, 3, 4])
  const bytes = await fs.readFile(outputPath, 'utf8')
  assert.equal(bytes.includes(requestId), false)
  assert.equal(bytes.includes(root), false)
  assert.equal(bytes.includes('private-run-marker'), false)

  let writes = 0
  const cancelled = await diagnostics.exportRequest({
    requestDigest,
    showSaveDialog: async () => ({ canceled: true }),
    writeAtomic: async () => { writes += 1 }
  })
  assert.deepEqual(cancelled, { status: 'cancelled', recordCount: 0, available: true })
  assert.equal(writes, 0)
})

test('SEM-F40/J30-DIAG: rolling store removes aged/oversized files and rotates at five files and one MiB', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  await fs.mkdir(directory)
  const now = Date.now()
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    const file = path.join(directory, `agent-run-diagnostics-${String(sequence).padStart(12, '0')}.jsonl`)
    await fs.writeFile(file, Buffer.alloc(MAX_FILE_BYTES + (sequence === 6 ? 1 : 0), 0x78))
  }
  const originalLstat = fs.lstat.bind(fs)
  const fsApi = new Proxy(fs, {
    get (target, property) {
      if (property === 'lstat') return async (filePath) => {
        const stats = await originalLstat(filePath)
        if (filePath.endsWith('agent-run-diagnostics-000000000001.jsonl')) {
          return {
            isDirectory: () => stats.isDirectory(),
            isSymbolicLink: () => stats.isSymbolicLink(),
            isFile: () => stats.isFile(),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            birthtimeMs: now - MAX_FILE_AGE_MS * 2
          }
        }
        return stats
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0', now: () => now, fsApi })
  await diagnostics.initialization
  assert.equal(diagnostics.getStatus().available, true)
  assert.equal(diagnostics.record(input()), true)
  assert.equal(await diagnostics.drain(), true)
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()
  assert.equal(files.length, MAX_FILES)
  assert.equal(files.includes('agent-run-diagnostics-000000000001.jsonl'), false)
  assert.ok(files.includes('agent-run-diagnostics-000000000007.jsonl'))
  for (const name of files) assert.ok((await fs.stat(path.join(directory, name))).size <= MAX_FILE_BYTES)
})

test('SEM-F40/J30-DIAG: allocating a sixth valid file evicts the oldest retained file', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  await fs.mkdir(directory)
  const now = Date.now()
  for (let sequence = 1; sequence <= MAX_FILES; sequence += 1) {
    const record = assertDiagnosticRecord({
      schemaVersion: 1,
      appVersion: '0.1.0',
      requestDigest: 'a'.repeat(64),
      runDigest: 'b'.repeat(64),
      attempt: 1,
      sequence,
      phase: 'accepted',
      event: 'accepted',
      elapsedMs: sequence,
      lastActivityAgeMs: null,
      errorCode: null,
      budgetAxis: null,
      metrics: { actual: null, limit: null, unit: null },
      modelBindingDigest: 'c'.repeat(64),
      planDigest: null
    })
    const file = path.join(directory, `agent-run-diagnostics-${String(sequence).padStart(12, '0')}.jsonl`)
    await fs.writeFile(file, `${JSON.stringify(record)}\n`)
  }

  const originalLstat = fs.lstat.bind(fs)
  const originalStat = fs.stat.bind(fs)
  const fsApi = new Proxy(fs, {
    get (target, property) {
      if (property === 'lstat') return async (filePath) => {
        const stats = await originalLstat(filePath)
        return {
          isDirectory: () => stats.isDirectory(),
          isSymbolicLink: () => stats.isSymbolicLink(),
          isFile: () => stats.isFile(),
          size: stats.size,
          mtimeMs: now,
          birthtimeMs: now
        }
      }
      if (property === 'stat') return async (filePath) => {
        const stats = await originalStat(filePath)
        return { size: filePath.endsWith('agent-run-diagnostics-000000000005.jsonl') ? MAX_FILE_BYTES : stats.size }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0', now: () => now, fsApi })
  await diagnostics.initialization
  assert.equal((await readRecords(directory)).records.length, MAX_FILES)
  assert.equal(diagnostics.record(input()), true)
  assert.equal(await diagnostics.drain(), true)

  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()
  assert.equal(files.length, MAX_FILES)
  assert.equal(files.includes('agent-run-diagnostics-000000000001.jsonl'), false)
  for (let sequence = 2; sequence <= MAX_FILES + 1; sequence += 1) {
    assert.ok(files.includes(`agent-run-diagnostics-${String(sequence).padStart(12, '0')}.jsonl`))
  }
  const { records } = await readRecords(directory)
  assert.equal(records.some((record) => record.sequence === MAX_FILES + 1), true)
})

test('SEM-F40/J30-DIAG: age retention is enforced after continuous appends to the current file', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  let now = Date.now()
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0', now: () => now })
  await diagnostics.initialization

  assert.equal(diagnostics.record(input()), true)
  assert.equal(await diagnostics.drain(), true)
  const firstFile = path.join(directory, 'agent-run-diagnostics-000000000001.jsonl')
  assert.equal((await fs.stat(firstFile)).isFile(), true)

  now += MAX_FILE_AGE_MS - 1000
  assert.equal(diagnostics.record(input({ elapsedMs: 43 })), true)
  assert.equal(await diagnostics.drain(), true)
  assert.equal((await fs.stat(firstFile)).isFile(), true, 'the current file remains within its seven-day retention window')

  now += 2000
  assert.equal(diagnostics.record(input({ elapsedMs: 44 })), true)
  assert.equal(await diagnostics.drain(), true)
  await assert.rejects(fs.stat(firstFile), { code: 'ENOENT' })
  const { files, records } = await readRecords(directory)
  assert.equal(files.length, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].sequence, 3)
})

test('SEM-F40/J30-DIAG: write failure is visible, bounded, and never retried indefinitely', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  let attempts = 0
  const fsApi = new Proxy(require('node:fs/promises'), {
    get (target, property) {
      if (property === 'appendFile') return async () => { attempts += 1; throw new Error('private filesystem error marker') }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const statuses = []
  const diagnostics = new AgentRunDiagnostics({
    directory, appVersion: '0.1.0', fsApi,
    onAvailabilityChanged: (status) => statuses.push(status)
  })
  await diagnostics.initialization
  assert.equal(diagnostics.record(input()), true)
  assert.equal(await diagnostics.drain(), false)
  assert.equal(diagnostics.getStatus().available, false)
  assert.equal(diagnostics.getStatus().errorCode, 'AGENT_DIAGNOSTICS_UNAVAILABLE')
  assert.equal(diagnostics.record(input()), false)
  assert.equal(diagnostics.pending.length, 1)
  assert.equal(diagnostics.pending.length <= MAX_BUFFERED_RECORDS, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 1)
  assert.ok(statuses.some((status) => status.available === false))
  assert.equal(JSON.stringify(statuses).includes('private filesystem error marker'), false)
})

test('SEM-F40/J30-DIAG: pre-write queue never exceeds 256 records', async (t) => {
  const root = await temporaryDirectory(t)
  const directory = path.join(root, 'diagnostics')
  let resolveGate
  const gate = new Promise((resolve) => { resolveGate = resolve })
  const fsApi = new Proxy(require('node:fs/promises'), {
    get (target, property) {
      if (property === 'appendFile') return async (...args) => { await gate.promise; return target.appendFile(...args) }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const diagnostics = new AgentRunDiagnostics({ directory, appVersion: '0.1.0', fsApi })
  await diagnostics.initialization
  for (let index = 0; index < MAX_BUFFERED_RECORDS; index += 1) {
    assert.equal(diagnostics.record(input({ elapsedMs: index })), true)
  }
  assert.equal(diagnostics.pending.length, MAX_BUFFERED_RECORDS)
  assert.equal(diagnostics.record(input()), false)
  assert.equal(diagnostics.pending.length, MAX_BUFFERED_RECORDS)
  assert.equal(diagnostics.getStatus().available, false)
  resolveGate()
  await new Promise((resolve) => setImmediate(resolve))
})
