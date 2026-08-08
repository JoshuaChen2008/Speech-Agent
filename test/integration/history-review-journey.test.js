'use strict'

/*
 * History review is composed from the production durability and session
 * layers.  The only seams here are Electron's utility process (the
 * service-backed host below), physical capture/ASR (FakeRuntimeAdapter), and
 * the operating-system save dialog.  StorageGateway still speaks the real
 * protocol to StorageWorkerService, which owns the real SqliteSubtitleStore.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

const { HistoryService } = require('../../src/main/services/history-service')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DEV_RUNTIME_WITH_REFINEMENT = Object.freeze({ ...DEV_RUNTIME, refinementAvailable: true })

function temporaryDirectory () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-journey-'))
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

/* This is the same in-process Electron utility-process substitute used by
   product-sqlite-lifecycle-journey.  Keeping the wire envelope here proves
   that history:list-sessions has been added to the actual worker protocol. */
function serviceBackedHost (service, databasePath, operations) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    operations.push(operation)
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `history-review-${++sequence}`,
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
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async getSessionPage (input) {
      return call(OPERATIONS.GET_SESSION_PAGE, input)
    },
    async listSessions (input) {
      return call(OPERATIONS.LIST_SESSIONS, input)
    },
    async getStats () {
      return call(OPERATIONS.GET_STATS, {})
    },
    async shutdown () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    },
    async terminateAndWait () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
      return 0
    }
  }
}

function createGateway (databasePath, operations) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath, operations),
    maxRestarts: 0
  })
  return { gateway, service }
}

function caption (sessionId, sourceId, overrides) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId,
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: 'final transcript body',
    translation: null,
    ...overrides
  }
}

test('CI journey: review completed SQLite sessions, their detail, and text-only exports', async (t) => {
  const root = temporaryDirectory()
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const exportDirectory = path.join(root, 'exports')
  const txtPath = path.join(exportDirectory, 'mic-session.txt')
  const mdPath = path.join(exportDirectory, 'mic-session.md')
  const srtPath = path.join(exportDirectory, 'mic-session.srt')
  const operations = []
  const { gateway } = createGateway(databasePath, operations)
  let clock = 1777700000000
  const sessionIds = ['mic-review-session', 'loopback-review-session']
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: DEV_RUNTIME_WITH_REFINEMENT,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: true
    },
    idFactory: () => sessionIds.shift()
  })
  const saveDialogCalls = []
  const chosenPaths = [txtPath, mdPath, srtPath]
  const ownerWindow = { role: 'history-window' }
  const history = new HistoryService({
    gateway,
    /* The production main-process service chooses this returned OS path; no
       renderer- or transcript-supplied destination path exists in the API. */
    showSaveDialog: async (owner, options) => {
      saveDialogCalls.push({ owner, options })
      return { canceled: false, filePath: chosenPaths.shift() }
    }
  })

  fs.mkdirSync(exportDirectory, { recursive: true })
  t.after(async () => {
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await gateway.start()
  assert.equal((await coordinator.command('start')).ok, true)
  const micSessionId = coordinator.getSnapshot().sessionId
  assert.equal(micSessionId, 'mic-review-session')
  assert.deepEqual(
    coordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['mic'],
    'the first session is microphone-only'
  )

  assert.deepEqual(await history.listSessions({ limit: 10, cursor: null }), {
    items: [],
    nextCursor: null
  }, 'active sessions do not enter the history list')

  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'partial', sequence: 1, revision: 1, text: 'recognizing interim words'
  }))
  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'final', sequence: 2, revision: 2, text: 'final transcript body'
  }))
  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'refined', sequence: 3, revision: 3, text: 'refined transcript body'
  }))
  await gateway.flush()

  clock += 2500
  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'idle')

  const closedMic = await history.listSessions({ limit: 10, cursor: null })
  assert.deepEqual(closedMic, {
    items: [{
      sessionId: micSessionId,
      mode: 'dictation',
      sourceId: 'mic',
      startedAt: 1777700000000,
      endedAt: 1777700002500,
      state: 'closed',
      segmentCount: 1
    }],
    nextCursor: null
  })

  const micDetail = await history.getSessionPage({
    sessionId: micSessionId,
    limit: 50,
    cursor: null
  })
  assert.deepEqual(micDetail.session, {
    sessionId: micSessionId,
    mode: 'dictation',
    sourceId: 'mic',
    startedAt: 1777700000000,
    endedAt: 1777700002500,
    state: 'closed'
  }, 'detail retains terminal state and both durable timestamps')
  assert.equal(micDetail.totalCount, 1)
  assert.equal(micDetail.nextCursor, null)
  assert.deepEqual(micDetail.items, [{
    segmentId: 'segment-1',
    sourceId: 'mic',
    text: 'final transcript body',
    refinedText: 'refined transcript body',
    textRevision: 2,
    t0Ms: 0,
    t1Ms: 1000
  }], 'partial 不落盘；默认正文是首次 final，精修稿作为独立版本并存（SEM-F04/F11）'),
  assert.equal(Object.hasOwn(micDetail, 'translation'), false)
  assert.equal(Object.hasOwn(micDetail, 'audioPath'), false)
  assert.equal(Object.hasOwn(micDetail.session, 'audioPath'), false)
  assert.equal(Object.hasOwn(micDetail.items[0], 'translation'), false)
  assert.equal(Object.hasOwn(micDetail.items[0], 'audioPath'), false)

  clock += 1000
  coordinator.updateConfiguration({
    onboardingCompleted: true,
    onboardingPreset: 'meeting',
    mic: false,
    loopback: true
  })
  assert.equal((await coordinator.command('start')).ok, true)
  const loopbackSessionId = coordinator.getSnapshot().sessionId
  assert.equal(loopbackSessionId, 'loopback-review-session')
  assert.deepEqual(
    coordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['loopback'],
    'the second session remains XOR loopback-only'
  )
  assert.deepEqual(
    (await history.listSessions({ limit: 10, cursor: null })).items.map((item) => item.sessionId),
    [micSessionId],
    'a second active session is also excluded from review'
  )
  adapter.emitCaption(caption(loopbackSessionId, 'loopback', {
    segmentId: 'loopback-segment', text: 'loopback final body'
  }))
  await gateway.flush()

  clock += 1000
  assert.equal((await coordinator.command('stop')).ok, true)

  const terminalSessions = await history.listSessions({ limit: 10, cursor: null })
  assert.deepEqual(terminalSessions.items.map((item) => item.sessionId), [
    loopbackSessionId,
    micSessionId
  ], 'completed sessions are stably newest-first')
  const newestOnly = await history.listSessions({ limit: 1, cursor: null })
  assert.equal(newestOnly.items[0].sessionId, loopbackSessionId)
  assert.deepEqual(newestOnly.nextCursor, {
    startedAt: 1777700003500,
    sessionId: loopbackSessionId
  })
  assert.deepEqual(
    (await history.listSessions({ limit: 1, cursor: newestOnly.nextCursor })).items.map((item) => item.sessionId),
    [micSessionId],
    'the keyset cursor preserves the same reverse ordering'
  )

  const txtResult = await history.exportSession({ sessionId: micSessionId, format: 'txt' }, ownerWindow)
  const mdResult = await history.exportSession({ sessionId: micSessionId, format: 'md' }, ownerWindow)
  const srtResult = await history.exportSession({ sessionId: micSessionId, format: 'srt' }, ownerWindow)
  assert.deepEqual(txtResult, { status: 'saved', format: 'txt', version: 'original' })
  assert.deepEqual(mdResult, { status: 'saved', format: 'md', version: 'original' })
  assert.deepEqual(srtResult, { status: 'saved', format: 'srt', version: 'original' })
  assert.equal(JSON.stringify(txtResult).includes(txtPath), false)
  assert.equal(JSON.stringify(mdResult).includes(mdPath), false)
  assert.equal(JSON.stringify(srtResult).includes(srtPath), false)
  assert.deepEqual(saveDialogCalls.map(({ owner }) => owner), [ownerWindow, ownerWindow, ownerWindow])
  assert.deepEqual(saveDialogCalls.map(({ options }) => options.filters[0].extensions), [['txt'], ['md'], ['srt']])
  /* 导出默认原始版（SEM-F11）：精修稿必须由用户明确选择才会被导出。 */
  assert.equal(fs.readFileSync(txtPath, 'utf8'), 'final transcript body\n')
  assert.match(fs.readFileSync(mdPath, 'utf8'), /- final transcript body\n$/)
  assert.equal(fs.readFileSync(srtPath, 'utf8'),
    '1\n00:00:00,000 --> 00:00:01,000\nfinal transcript body\n')

  assert.ok(operations.includes(OPERATIONS.LIST_SESSIONS),
    'HistoryService listing must cross the real storage-worker list-sessions operation')
  assert.ok(operations.includes(OPERATIONS.GET_SESSION_PAGE),
    'HistoryService detail must cross the bounded storage-worker page operation')
  assert.deepEqual(audioFilesUnder(root), [], 'history review and exports do not create raw-audio files')
})

function publicProjection (segment) {
  return {
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
    refinedText: segment.refinedText,
    textRevision: segment.textRevision,
    t0Ms: segment.t0Ms,
    t1Ms: segment.t1Ms
  }
}

function digest (value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function cursorIsAfter (next, previous) {
  if (previous === null) return true
  return next.t0Ms > previous.t0Ms ||
    (next.t0Ms === previous.t0Ms && next.firstEventOrder > previous.firstEventOrder)
}

test('CI journey: 205 refined captions page through the real durability stack without truncating exports', async (t) => {
  const root = temporaryDirectory()
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const exportDirectory = path.join(root, 'exports')
  const exportPaths = ['txt', 'md', 'srt'].map((extension) =>
    path.join(exportDirectory, `long-session.${extension}`))
  const refinedExportPath = path.join(exportDirectory, 'long-session-refined.txt')
  const operations = []
  const { gateway } = createGateway(databasePath, operations)
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  let clock = 1777800000000
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: DEV_RUNTIME_WITH_REFINEMENT,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: true
    },
    idFactory: () => 'long-history-session'
  })
  const chosenPaths = [...exportPaths, refinedExportPath]
  const history = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: false, filePath: chosenPaths.shift() })
  })

  fs.mkdirSync(exportDirectory, { recursive: true })
  t.after(async () => {
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await gateway.start()
  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  let sequence = 0
  const refinedIndexes = new Set([49, 50, 99, 100, 149, 150, 199, 200])
  for (let index = 0; index < 205; index += 1) {
    if (index % 11 === 0 || index % 17 === 0) refinedIndexes.add(index)
    const t0 = Math.floor(index / 7) / 10
    const segmentId = `long-segment-${String(index + 1).padStart(3, '0')}`
    adapter.emitCaption(caption(sessionId, 'mic', {
      segmentId,
      sequence: ++sequence,
      revision: 1,
      t0,
      t1: t0 + 0.08,
      text: `final subtitle ${String(index + 1).padStart(3, '0')}`
    }))
    if (refinedIndexes.has(index)) {
      adapter.emitCaption(caption(sessionId, 'mic', {
        segmentId,
        sequence: ++sequence,
        revision: 2,
        kind: 'refined',
        t0,
        t1: t0 + 0.08,
        text: `refined subtitle ${String(index + 1).padStart(3, '0')}`
      }))
    }
  }
  await gateway.flush()
  clock += 30000
  assert.equal((await coordinator.command('stop')).ok, true)
  await gateway.flush()

  const fullTranscript = await gateway.getSessionTranscript(sessionId)
  const expected = fullTranscript.segments.map(publicProjection)
  assert.equal(expected.length, 205)
  const pageOperationStart = operations.length
  const collected = []
  const cursors = []
  let cursor = null
  let pageCount = 0
  let sameTimestampBoundaryCount = 0
  do {
    const page = await history.getSessionPage({ sessionId, limit: 50, cursor })
    pageCount += 1
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor', 'refinement', 'session', 'totalCount'])
    assert.deepEqual(Object.keys(page.session).sort(), ['endedAt', 'mode', 'sessionId', 'sourceId', 'startedAt', 'state'])
    assert.equal(page.totalCount, 205)
    assert.deepEqual(page.refinement, {
      segmentCount: 205,
      refinedSegmentCount: refinedIndexes.size,
      refinementResultStatus: 'known',
      refinementEnabled: true,
      refinementFaultCode: null
    }, '整场精修覆盖来自 SQLite 权威行而不是当前 50 条分页（SEM-F11）')
    assert.ok(page.items.length > 0 && page.items.length <= 50)
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item).sort(),
        ['refinedText', 'segmentId', 'sourceId', 't0Ms', 't1Ms', 'text', 'textRevision'])
      assert.doesNotMatch(JSON.stringify(item), /audio|path|sql|translation|eventOrder/i)
    }
    if (collected.length > 0 && collected.at(-1).t0Ms === page.items[0].t0Ms) {
      sameTimestampBoundaryCount += 1
    }
    collected.push(...page.items)
    if (page.nextCursor !== null) {
      assert.deepEqual(Object.keys(page.nextCursor).sort(), ['firstEventOrder', 't0Ms'])
      assert.equal(cursorIsAfter(page.nextCursor, cursor), true)
      cursors.push(page.nextCursor)
    }
    cursor = page.nextCursor
  } while (cursor !== null)

  const pageOperations = operations.slice(pageOperationStart)
  assert.equal(pageCount, 5)
  assert.equal(cursors.length, 4)
  assert.ok(sameTimestampBoundaryCount >= 4, 'all four full-page boundaries split equal-timestamp groups')
  assert.equal(new Set(collected.map(({ segmentId }) => segmentId)).size, 205)
  assert.deepEqual(collected, expected)
  assert.equal(digest(collected), digest(expected))
  assert.equal(pageOperations.every((operation) => operation === OPERATIONS.GET_SESSION_PAGE), true,
    'the renderer-facing page loop cannot fall back to the private full transcript operation')
  /* 版本隔离（SEM-F04/F11）：精修过的段落默认仍呈现首次 final，精修稿并存。 */
  for (const index of refinedIndexes) {
    assert.equal(collected[index].textRevision, 1)
    assert.match(collected[index].text, /^final subtitle /)
    assert.match(collected[index].refinedText, /^refined subtitle /)
  }

  for (const format of ['txt', 'md', 'srt']) {
    assert.deepEqual(await history.exportSession({ sessionId, format }), { status: 'saved', format, version: 'original' })
  }
  const txt = fs.readFileSync(exportPaths[0], 'utf8')
  const md = fs.readFileSync(exportPaths[1], 'utf8')
  const srt = fs.readFileSync(exportPaths[2], 'utf8')
  assert.equal(txt.trimEnd().split('\n').length, 205)
  assert.equal((md.match(/^- /gm) || []).length, 205)
  assert.equal((srt.match(/^\d+$/gm) || []).length, 205)
  /* 完整导出默认取原始版：精修过的第 50 段也必须导出首次 final。 */
  assert.match(txt, /final subtitle 050/)
  assert.doesNotMatch(txt, /refined subtitle 050/)
  assert.match(srt, /\n205\n[^\n]+\nfinal subtitle 205\n$/)

  /* SEM-T08：原始版与精修版的导出必须分别核对，而不是核对一份折叠后的投影。
     精修过的段落在精修版里换成精修稿，其余段落回落到原始版，所以两份内容
     不同但段落数相同。 */
  assert.deepEqual(await history.exportSession({ sessionId, format: 'txt', version: 'refined' }),
    { status: 'saved', format: 'txt', version: 'refined' })
  const refinedTxt = fs.readFileSync(refinedExportPath, 'utf8')
  assert.notEqual(digest(refinedTxt), digest(txt), '两个版本的导出 digest 必须不同')
  const refinedLines = refinedTxt.trimEnd().split('\n')
  assert.equal(refinedLines.length, 207, '不完整精修导出有两行覆盖提示，正文段数仍保持 205')
  assert.match(refinedLines[0], new RegExp(`已精修 ${refinedIndexes.size}/205 段`))
  assert.equal(refinedLines[1], '')
  assert.match(refinedTxt, /refined subtitle 050/)
  assert.doesNotMatch(refinedTxt, /final subtitle 050/)
  assert.match(refinedTxt, /\[原始版回退] final subtitle 002/,
    '没有精修稿的段落在精修版里回落到原始版并明确标记')
  await assert.rejects(
    history.exportSession({ sessionId, format: 'txt', version: 'latest' }),
    (error) => error.code === 'INVALID_EXPORT_VERSION'
  )

  assert.ok(operations.includes(OPERATIONS.OPEN_SESSION))
  assert.ok(operations.includes(OPERATIONS.APPEND_CAPTION))
  assert.ok(operations.includes(OPERATIONS.CLOSE_SESSION))
  assert.ok(operations.includes(OPERATIONS.GET_SESSION_PAGE))
  assert.ok(operations.includes(OPERATIONS.GET_SESSION), 'full transcript stays private to comparison and export')
  assert.deepEqual(audioFilesUnder(root), [])
})

async function settleHistoryRenderer () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

async function waitForHistoryExport (statusElement) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (statusElement.textContent !== '正在准备导出…') return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  throw new Error('history renderer export did not settle')
}

async function loadHistoryView () {
  const filename = path.join(__dirname, '..', '..', 'src', 'history', 'history-view.tsx')
  const { transformWithOxc } = await import('vite')
  const transformed = await transformWithOxc(fs.readFileSync(filename, 'utf8'), filename, { lang: 'tsx' })
  const output = transformed.code
    .replace(/import \{([^}]+)\} from "react";/, (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react");`)
    .replace(/import Icons from "\.\.\/ui\/shared\/fluent-icons";/,
      'const Icons = { iconMarkup: () => `<svg aria-hidden="true"></svg>` };')
    .replace(/import \{([^}]+)\} from "react\/jsx-runtime";/,
      (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react/jsx-runtime");`)
    .replace('export function HistoryView', 'function HistoryView') + '\nmodule.exports = { HistoryView };\n'
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(output, filename)
  return loaded.exports.HistoryView
}

async function createHistoryRenderer (history) {
  const HistoryView = await loadHistoryView()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://history.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event'].map((key) => [key, global[key]]))
  global.window = dom.window; global.document = dom.window.document
  global.HTMLElement = dom.window.HTMLElement; global.Event = dom.window.Event
  global.IS_REACT_ACT_ENVIRONMENT = true
  const api = {
    dragStart () {},
    dragEnd () {},
    close () {},
    onConfig () {},
    getConfig: async () => ({ theme: 'dark', systemDark: true }),
    listSessions: async (limit, cursor) => ({
      ok: true,
      value: await history.listSessions({ limit, cursor })
    }),
    getSessionPage: async (sessionId, limit, cursor) => ({
      ok: true,
      value: await history.getSessionPage({ sessionId, limit, cursor })
    }),
    exportSession: async (sessionId, format, version) => ({
      ok: true,
      value: await history.exportSession({ sessionId, format, version })
    })
  }
  dom.window.historyApi = api
  dom.window.ManualWindowDrag = {
    bindManualWindowDrag: () => ({ end () {} }),
    isInteractiveDragEvent: () => false
  }
  const reactRoot = createRoot(document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(HistoryView)))
  await settleHistoryRenderer()
  return {
    document: dom.window.document,
    async dispose () {
      await act(async () => reactRoot.unmount()); dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    }
  }
}

test('CI journey: history renderer scopes version selection and export to the selected session', async (t) => {
  const root = temporaryDirectory()
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const refinedPath = path.join(root, 'exports', 'session-a-refined.txt')
  const originalPath = path.join(root, 'exports', 'session-b-original.txt')
  const operations = []
  const { gateway } = createGateway(databasePath, operations)
  const exportPaths = [refinedPath, originalPath]
  const history = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: false, filePath: exportPaths.shift() })
  })
  const sessionA = 'history-version-session-a'
  const sessionB = 'history-version-session-b'

  t.after(async () => {
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.dirname(refinedPath), { recursive: true })
  await gateway.start()
  await gateway.openSession({
    sessionId: sessionA,
    sourceId: 'mic',
    startedAt: 1_777_900_000_000,
    refinementEnabled: true
  })
  let sequence = 0
  for (let index = 0; index < 51; index += 1) {
    const segmentId = `version-a-${String(index).padStart(3, '0')}`
    await gateway.appendCaption(caption(sessionA, 'mic', {
      segmentId,
      sequence: ++sequence,
      revision: 1,
      t0: index,
      t1: index + 0.5,
      text: `session A original ${index}`
    }))
    await gateway.appendCaption(caption(sessionA, 'mic', {
      segmentId,
      sequence: ++sequence,
      revision: 2,
      kind: 'refined',
      t0: index,
      t1: index + 0.5,
      text: `session A refined ${index}`
    }))
  }
  await gateway.closeSession({
    sessionId: sessionA,
    sourceId: 'mic',
    endedAt: 1_777_900_100_000,
    state: 'closed'
  })
  await gateway.openSession({
    sessionId: sessionB,
    sourceId: 'loopback',
    startedAt: 1_777_900_200_000,
    refinementEnabled: true
  })
  await gateway.appendCaption(caption(sessionB, 'loopback', {
    segmentId: 'version-b-000',
    sequence: 1,
    revision: 1,
    t0: 0,
    t1: 0.5,
    text: 'session B original 0'
  }))
  await gateway.appendCaption(caption(sessionB, 'loopback', {
    segmentId: 'version-b-000',
    sequence: 2,
    revision: 2,
    kind: 'refined',
    t0: 0,
    t1: 0.5,
    text: 'session B refined 0'
  }))
  await gateway.closeSession({
    sessionId: sessionB,
    sourceId: 'loopback',
    endedAt: 1_777_900_300_000,
    state: 'closed'
  })
  await gateway.flush()

  const renderer = await createHistoryRenderer(history)
  t.after(() => renderer.dispose())
  const cardBySessionId = new Map([...renderer.document.querySelectorAll('[data-session-id]')]
    .map((item) => [item.dataset.sessionId, item]))
  const timeline = renderer.document.getElementById('timeline')

  await act(async () => cardBySessionId.get(sessionA).click())
  await settleHistoryRenderer()
  assert.equal(timeline.querySelectorAll('.timeline-item').length, 50)
  assert.equal(timeline.querySelector('.caption-text').textContent, 'session A original 0',
    'a newly selected session starts with its first-pass final text')

  await act(async () => renderer.document.querySelector('[data-version="refined"]').click())
  assert.equal(timeline.querySelector('.caption-text').textContent, 'session A refined 0')
  await act(async () => renderer.document.getElementById('nextPage').click())
  await settleHistoryRenderer()
  assert.equal(timeline.querySelectorAll('.timeline-item').length, 1)
  assert.equal(timeline.querySelector('.caption-text').textContent, 'session A refined 50',
    'the explicit choice persists while paging within the same session')

  await act(async () => renderer.document.querySelector('[data-export="txt"]').click())
  await waitForHistoryExport(renderer.document.getElementById('exportStatus'))
  assert.equal(renderer.document.getElementById('exportStatus').textContent, '字幕精修稿已导出')
  assert.match(fs.readFileSync(refinedPath, 'utf8'), /session A refined 50/,
    'the export follows the current session’s explicit refined selection')

  await act(async () => cardBySessionId.get(sessionB).click())
  await settleHistoryRenderer()
  assert.equal(timeline.querySelector('.caption-text').textContent, 'session B original 0',
    'choosing another session resets the display to the immutable first-pass final')
  assert.equal(renderer.document.querySelector('[data-version="original"]').getAttribute('aria-checked'), 'true')
  assert.equal(renderer.document.querySelector('[data-version="refined"]').getAttribute('aria-checked'), 'false')

  await act(async () => renderer.document.querySelector('[data-export="txt"]').click())
  await waitForHistoryExport(renderer.document.getElementById('exportStatus'))
  assert.equal(renderer.document.getElementById('exportStatus').textContent, '字幕原文已导出')
  assert.match(fs.readFileSync(originalPath, 'utf8'), /session B original 0/,
    'the next session exports its reset original selection')
  assert.doesNotMatch(fs.readFileSync(originalPath, 'utf8'), /session B refined 0/)
  assert.ok(operations.includes(OPERATIONS.GET_SESSION_PAGE))
  assert.ok(operations.includes(OPERATIONS.GET_SESSION))
  assert.deepEqual(audioFilesUnder(root), [], 'the full review journey creates no raw-audio files')
})
