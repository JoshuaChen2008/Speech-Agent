'use strict'

/*
 * J27 proves the durable boundary between the product composition root and
 * the manually launched legacy Agent MVP entry.  The formal side uses the
 * production SubtitleApplicationRuntime with a deterministic in-process
 * storage host; the isolation side runs the real Electron entry and smoke
 * renderer in a second userData directory.
 */

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const electronPath = require('electron')
const { SubtitleApplicationRuntime } = require('../../src/main/services/subtitle-application-runtime')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')

const ROOT = path.resolve(__dirname, '../..')

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `j27-isolation-${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }

  return {
    async start () {
      if (started) return
      call(OPERATIONS.INITIALIZE, { databasePath })
      started = true
    },
    async openSession (input) {
      return call(OPERATIONS.OPEN_SESSION, input, makeOpenSessionKey(input.sessionId))
    },
    async appendCaption (event) {
      return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))
    },
    async closeSession (input) {
      return call(OPERATIONS.CLOSE_SESSION, input, makeCloseSessionKey(input.sessionId))
    },
    async recoverStaleSessions (input) {
      return call(OPERATIONS.RECOVER_STALE_SESSIONS, input)
    },
    async importLegacyJsonl (input) {
      return call(OPERATIONS.IMPORT_LEGACY_JSONL, input)
    },
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async shutdown () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    },
    async terminateAndWait () {
      await this.shutdown()
      return 0
    }
  }
}

function createFormalRuntime (userDataDir) {
  const databasePath = path.join(userDataDir, 'data', 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  const runtime = new SubtitleApplicationRuntime({
    userDataDir,
    now: () => 1770000000000,
    gatewayFactory: () => gateway,
    coordinatorFactory: () => ({
      async shutdownForAppQuit () {},
      dispose () {}
    })
  })
  return { databasePath, gateway, runtime }
}

function runIsolatedAgentMvp (userDataDir) {
  return new Promise((resolve, reject) => {
    const privacyCanary = crypto.randomBytes(24).toString('hex')
    const thoughtCanary = crypto.randomBytes(24).toString('hex')
    const child = childProcess.spawn(electronPath, ['--disable-gpu', path.join(ROOT, 'src', 'agent-mvp', 'main.js')], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_MVP_SMOKE: '1',
        AGENT_MVP_SMOKE_SCENARIO: 'happy-restart',
        AGENT_MVP_SMOKE_PHASE: 'first',
        AGENT_MVP_USER_DATA: userDataDir,
        AGENT_MVP_SMOKE_CREDENTIAL: privacyCanary,
        AGENT_MVP_SMOKE_THOUGHT: thoughtCanary,
        ELECTRON_DISABLE_LOGGING: 'true'
      }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('isolated Agent MVP entry timed out'))
    }, 45000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`isolated Agent MVP entry exited ${code}: ${stdout.slice(-400)} ${stderr.slice(-400)}`))
        return
      }
      const line = stdout.split(/\r?\n/).find((value) => value.trim().startsWith('{"schemaVersion":2'))
      if (!line) {
        reject(new Error('isolated Agent MVP report is missing'))
        return
      }
      try {
        resolve({ report: JSON.parse(line), privacyCanary, thoughtCanary })
      } catch (error) {
        reject(error)
      }
    })
  })
}

function filesUnder (root) {
  const files = []
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.push(target)
    }
  }
  visit(root)
  return files
}

function relativeFiles (root) {
  return filesUnder(root).map((file) => path.relative(root, file).replace(/\\/g, '/')).sort()
}

test('SEM-F29/J27: formal product and isolated Agent MVP keep separate userData and SQLite roots', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-j27-userdata-'))
  const formalUserData = path.join(root, 'formal-user-data')
  const isolatedUserData = path.join(root, 'isolated-agent-user-data')
  fs.mkdirSync(formalUserData, { recursive: true })
  fs.mkdirSync(isolatedUserData, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const formal = createFormalRuntime(formalUserData)
  try {
    const started = await formal.runtime.start()
    assert.equal(started.databasePath, formal.databasePath)
    await formal.gateway.openSession({
      sessionId: 'j27-formal-session',
      sourceId: 'mic',
      startedAt: 1770000000000,
      refinementEnabled: false
    })
    await formal.gateway.appendCaption({
      schemaVersion: 1,
      sessionId: 'j27-formal-session',
      sourceId: 'mic',
      segmentId: 'j27-formal-segment',
      sequence: 1,
      revision: 1,
      kind: 'final',
      t0: 0,
      t1: 1,
      text: '正式入口字幕事实',
      translation: null
    })
    await formal.gateway.closeSession({
      sessionId: 'j27-formal-session',
      sourceId: 'mic',
      endedAt: 1770000001000,
      state: 'closed'
    })
    await formal.gateway.flush()

    const isolated = await runIsolatedAgentMvp(isolatedUserData)
    assert.equal(isolated.report.result, 'pass')
    assert.equal(isolated.report.sessionCount, 1)

    const isolatedDatabase = path.join(isolatedUserData, 'agent-mvp.sqlite')
    assert.equal(fs.existsSync(formal.databasePath), true)
    assert.equal(fs.existsSync(isolatedDatabase), true)
    assert.equal(path.resolve(formal.databasePath) === path.resolve(isolatedDatabase), false)

    const formalFiles = relativeFiles(formalUserData)
    const isolatedFiles = relativeFiles(isolatedUserData)
    assert.equal(formalFiles.includes('data/speech-agent.sqlite3'), true)
    assert.equal(formalFiles.some((file) => file === 'agent-mvp.sqlite' || file.startsWith('agent-mvp.sqlite-')), false)
    assert.equal(isolatedFiles.includes('agent-mvp.sqlite'), true)
    assert.equal(isolatedFiles.some((file) => file === 'data/speech-agent.sqlite3' || file.startsWith('data/speech-agent.sqlite3-')), false)
    assert.equal(JSON.stringify(isolated.report).includes(formalUserData), false)
    assert.equal(JSON.stringify(isolated.report).includes(isolatedUserData), false)
  } finally {
    await formal.runtime.shutdownWithin(5000)
  }
})
