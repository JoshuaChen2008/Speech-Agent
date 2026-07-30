'use strict'

// @ts-check

/* Real Electron product-shell journey. It loads src/main.js with an isolated
   userData directory and the explicit fake-ASR development seam, then drives
   the actual settings/toolbar/caption/history renderers through their DOM and
   preload IPC. It never opens a physical audio source and never kills a
   process by executable name. */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../src/runtime/storage-worker/worker-service')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const LONG_HISTORY_SESSION_ID = 'ci-long-history-session'
const LONG_HISTORY_SEGMENT_COUNT = 205
const HISTORY_PAGE_SIZE = 50

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv) {
  const values = { workDir: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1]
    if (argv[index] === '--work-dir') { values.workDir = next; index += 1 } else if (argv[index] === '--report') { values.report = next; index += 1 } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  if (!values.workDir || !values.report) throw new Error('--work-dir and --report are required')
  const artifacts = path.join(PROJECT_ROOT, '.artifacts')
  const workDir = path.resolve(PROJECT_ROOT, values.workDir)
  const report = path.resolve(PROJECT_ROOT, values.report)
  if (!isWithin(artifacts, workDir) || !isWithin(artifacts, report)) throw new Error('smoke outputs must stay under .artifacts')
  if (fs.existsSync(workDir)) throw new Error('work directory must not already exist')
  return { workDir, report }
}

function windowFor (suffix) {
  const normalized = suffix.replace(/\\/g, '/')
  return BrowserWindow.getAllWindows().find((win) => {
    if (win.isDestroyed()) return false
    return decodeURIComponent(win.webContents.getURL()).replace(/\\/g, '/').endsWith(normalized)
  }) || null
}

async function waitFor (probe, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

function rendererValue (win, expression) {
  if (!win || win.isDestroyed()) throw new Error('renderer window is unavailable')
  return win.webContents.executeJavaScript(expression)
}

async function waitForHistoryPage (win, firstPosition, lastPosition) {
  return waitFor(async () => {
    const state = await rendererValue(win, `(() => {
      const timeline = document.getElementById('timeline')
      const items = [...timeline.children]
      return {
        busy: timeline.getAttribute('aria-busy'),
        count: items.length,
        first: Number(items[0]?.getAttribute('aria-posinset')),
        last: Number(items.at(-1)?.getAttribute('aria-posinset')),
        setSize: Number(items[0]?.getAttribute('aria-setsize')),
        positionsAligned: items.every((item, index) =>
          Number(item.getAttribute('aria-posinset')) === ${firstPosition} + index &&
          Number(item.getAttribute('aria-setsize')) === ${LONG_HISTORY_SEGMENT_COUNT})
      }
    })()`)
    return state.busy === 'false' &&
      state.count === lastPosition - firstPosition + 1 &&
      state.first === firstPosition && state.last === lastPosition &&
      state.setSize === LONG_HISTORY_SEGMENT_COUNT && state.positionsAligned === true
      ? state
      : null
  }, `history page ${firstPosition}-${lastPosition}`)
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(entry.name)
    }
  }
  visit(directory)
  return found
}

function createDevelopmentModelFixtures (workDir) {
  const fixtureRoot = path.join(workDir, 'model-fixtures')
  const realtime = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'x-asr-160ms')
  const refinement = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'x-asr-offline')
  const vad = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'silero-vad')
  if (!realtime || !refinement || !vad) throw new Error('production model manifest is incomplete')

  const realtimeRoot = path.join(fixtureRoot, 'realtime')
  const refinementRoot = path.join(fixtureRoot, 'refinement')
  const vadRoot = path.join(fixtureRoot, 'vad')
  for (const directory of [realtimeRoot, refinementRoot, vadRoot]) fs.mkdirSync(directory, { recursive: true })
  for (const file of realtime.requiredFiles) fs.writeFileSync(path.join(realtimeRoot, file), 'product-shell-fixture\n')
  for (const file of refinement.requiredFiles) fs.writeFileSync(path.join(refinementRoot, file), 'product-shell-fixture\n')
  const vadPath = path.join(vadRoot, vad.fileName)
  fs.writeFileSync(vadPath, 'product-shell-fixture\n')
  return { realtimeRoot, refinementRoot, vadPath }
}

function seedLongHistoryFixture (databasePath) {
  const service = new StorageWorkerService()
  let requestSequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `product-shell-fixture-${++requestSequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new Error(`long history fixture failed: ${response.error.code}`)
    return response.result
  }
  const startedAt = 1700000000000
  let captionSequence = 0
  try {
    call(OPERATIONS.INITIALIZE, { databasePath })
    call(OPERATIONS.OPEN_SESSION, {
      sessionId: LONG_HISTORY_SESSION_ID,
      sourceId: 'mic',
      startedAt
    }, makeOpenSessionKey(LONG_HISTORY_SESSION_ID))
    for (let index = 0; index < LONG_HISTORY_SEGMENT_COUNT; index += 1) {
      const t0 = Math.floor(index / 7) / 10
      const segmentId = `ci-long-segment-${String(index + 1).padStart(3, '0')}`
      const finalEvent = {
        schemaVersion: 1,
        sessionId: LONG_HISTORY_SESSION_ID,
        sourceId: 'mic',
        segmentId,
        sequence: ++captionSequence,
        revision: 1,
        kind: 'final',
        t0,
        t1: t0 + 0.08,
        text: `fixture subtitle ${String(index + 1).padStart(3, '0')}`,
        translation: null
      }
      call(OPERATIONS.APPEND_CAPTION, { event: finalEvent }, makeCaptionEventId(finalEvent))
      if (index % 11 === 0 || index % 17 === 0 || [49, 50, 99, 100, 149, 150, 199, 200].includes(index)) {
        const refinedEvent = {
          ...finalEvent,
          sequence: ++captionSequence,
          revision: 2,
          kind: 'refined',
          text: `fixture refined subtitle ${String(index + 1).padStart(3, '0')}`
        }
        call(OPERATIONS.APPEND_CAPTION, { event: refinedEvent }, makeCaptionEventId(refinedEvent))
      }
    }
    call(OPERATIONS.CLOSE_SESSION, {
      sessionId: LONG_HISTORY_SESSION_ID,
      sourceId: 'mic',
      endedAt: startedAt + 30000,
      state: 'closed'
    }, makeCloseSessionKey(LONG_HISTORY_SESSION_ID))
  } finally {
    if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
  }
}

const options = parseArguments(process.argv.slice(2))
fs.mkdirSync(options.workDir, { recursive: false })
const userDataDir = path.join(options.workDir, 'user-data')
fs.mkdirSync(userDataDir, { recursive: false })
app.setPath('userData', userDataDir)
seedLongHistoryFixture(path.join(userDataDir, 'data', 'speech-agent.sqlite3'))
const modelFixtures = createDevelopmentModelFixtures(options.workDir)
process.env.LIVE_SUBTITLE_MODEL_DIR = modelFixtures.realtimeRoot
process.env.LIVE_SUBTITLE_REFINE_MODEL_DIR = modelFixtures.refinementRoot
process.env.LIVE_SUBTITLE_VAD_MODEL = modelFixtures.vadPath
process.env.LIVE_SUBTITLE_DEV_MODEL = 'x-asr-480ms'

const crashEvents = []
app.on('child-process-gone', (_event, details) => {
  crashEvents.push({ role: details.type, reason: details.reason, exitCode: details.exitCode })
})
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_goneEvent, details) => {
    crashEvents.push({ role: 'renderer', reason: details.reason, exitCode: details.exitCode })
  })
})

let watchdog = null
let smokeFailed = false

app.whenReady().then(() => {
  watchdog = setTimeout(() => {
    console.error('product shell smoke watchdog expired')
    app.exit(1)
  }, 45000)
  void runJourney().catch(async (error) => {
    smokeFailed = true
    console.error(error && error.stack ? error.stack : error)
    const failure = {
      schemaVersion: 1,
      kind: 'product-shell-smoke',
      result: 'fail',
      errorCode: 'PRODUCT_SHELL_SMOKE_FAILED',
      crashEventCount: crashEvents.length
    }
    await fsp.writeFile(options.report, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' }).catch(() => {})
    process.exitCode = 1
    app.quit()
  })
})

async function runJourney () {
  const settings = await waitFor(() => windowFor('/settings/settings.html'), 'settings renderer')
  const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar renderer')
  const caption = await waitFor(() => windowFor('/caption/index.html'), 'caption renderer')
  await Promise.all([settings, toolbar, caption].map((win) => waitFor(() => !win.webContents.isLoading(), 'renderer load')))

  await rendererValue(settings, `document.querySelector('[data-preset="dictation"]').click(); true`)
  await waitFor(() => rendererValue(settings, `document.getElementById('onboarding').hidden`), 'dictation onboarding')
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.capabilities.canStart)`), 'idle runtime')
  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="start"]:not(:disabled)')`), 'start control')

  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'listening' && s.sessionId !== null)`), 'listening runtime')
  await waitFor(() => rendererValue(caption, `document.getElementById('liveRegion').textContent.length > 0`), 'final caption', 15000)

  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="stop"]:not(:disabled)')`), 'stop control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="stop"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.sessionId === null)`), 'stopped runtime')

  await rendererValue(toolbar, `document.querySelector('button[data-act="history"]').click(); true`)
  const history = await waitFor(() => windowFor('/history/index.html'), 'history renderer')
  await waitFor(() => !history.webContents.isLoading(), 'history load')
  const historyCount = await waitFor(async () => {
    const count = await rendererValue(history, `document.querySelectorAll('.session-card').length`)
    return count > 0 ? count : 0
  }, 'terminal history')
  await waitFor(() => rendererValue(history,
    `!!document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]')`),
  'long history fixture card')
  await rendererValue(history, `(() => {
    const timeline = document.getElementById('timeline')
    const probe = { maxNodes: timeline.childElementCount, appendCalls: 0 }
    const appendChild = timeline.appendChild.bind(timeline)
    timeline.appendChild = (node) => {
      const result = appendChild(node)
      probe.appendCalls += 1
      probe.maxNodes = Math.max(probe.maxNodes, timeline.childElementCount)
      return result
    }
    window.__historyDomProbe = probe
    return true
  })()`)
  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]').click(); true`)

  const visitedHistoryPages = []
  visitedHistoryPages.push(await waitForHistoryPage(history, 1, 50))
  for (const [first, last] of [[51, 100], [101, 150], [151, 200], [201, 205]]) {
    await rendererValue(history, `document.getElementById('nextPage').click(); true`)
    visitedHistoryPages.push(await waitForHistoryPage(history, first, last))
  }
  const reachedHistoryEnd = await rendererValue(history,
    `document.getElementById('nextPage').disabled === true && document.getElementById('previousPage').disabled === false`)
  await rendererValue(history, `document.getElementById('previousPage').click(); true`)
  await waitForHistoryPage(history, 151, 200)
  await rendererValue(history, `document.getElementById('nextPage').click(); true`)
  await waitForHistoryPage(history, 201, 205)
  const historyProbe = await rendererValue(history, `({
    maxNodes: window.__historyDomProbe.maxNodes,
    appendCalls: window.__historyDomProbe.appendCalls,
    currentNodes: document.getElementById('timeline').childElementCount
  })`)
  const historyBackForwardNavigation = historyProbe.currentNodes === 5
  const historyAriaRangeAligned = visitedHistoryPages.every((state, index) =>
    state.first === index * HISTORY_PAGE_SIZE + 1 &&
    state.last === Math.min((index + 1) * HISTORY_PAGE_SIZE, LONG_HISTORY_SEGMENT_COUNT) &&
    state.setSize === LONG_HISTORY_SEGMENT_COUNT && state.positionsAligned === true)
  if (visitedHistoryPages.length !== 5 || !reachedHistoryEnd || !historyBackForwardNavigation ||
      !historyAriaRangeAligned || historyProbe.maxNodes > HISTORY_PAGE_SIZE || historyProbe.appendCalls < 260) {
    throw new Error('bounded history paging contract is not aligned: ' +
      `pages=${visitedHistoryPages.length} reachedEnd=${reachedHistoryEnd} ` +
      `backForward=${historyBackForwardNavigation} aria=${historyAriaRangeAligned} ` +
      `maxNodes=${historyProbe.maxNodes} appendCalls=${historyProbe.appendCalls}`)
  }

  await rendererValue(toolbar, `window.shell.action('open-model-manager'); true`)
  await waitFor(() => rendererValue(settings, `document.querySelector('.pane[data-pane="resources"]').classList.contains('active')`), 'resource navigation')
  const modelState = await rendererValue(settings, `window.shell.getModelStatus().then(s => s.state)`)
  const resourceCount = await rendererValue(settings, `document.querySelectorAll('[data-resource-id]').length`)
  const translationTogglePresent = await rendererValue(settings, `document.body.textContent.includes('显示双语译文')`)
  if (modelState !== 'ready' || resourceCount !== 3 || translationTogglePresent) throw new Error('model resources UI contract is not aligned')
  if (crashEvents.length > 0) throw new Error('Electron child process crashed during the product journey')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('product shell smoke persisted audio')

  const report = {
    schemaVersion: 1,
    kind: 'product-shell-smoke',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'partial',
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      rendererCount: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
      crashEventCount: crashEvents.length
    },
    journey: {
      onboardingPreset: 'dictation',
      startListeningStop: true,
      finalCaptionRendered: true,
      terminalHistoryCount: historyCount,
      longHistorySegmentCount: LONG_HISTORY_SEGMENT_COUNT,
      historyPageCount: visitedHistoryPages.length,
      historyPageSize: HISTORY_PAGE_SIZE,
      historyMaxTimelineNodes: historyProbe.maxNodes,
      historyReachedEnd: reachedHistoryEnd,
      historyBackForwardNavigation,
      historyAriaRangeAligned,
      resourcesPaneOpenedFromToolbar: true,
      modelState,
      resourceCount,
      modelReadinessSource: 'development-fixture-files',
      translationAdvertised: false
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'development-model-fixtures-no-real-inference',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      'not-packaged-i4'
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (watchdog) clearTimeout(watchdog)
  app.quit()
}

app.on('will-quit', () => {
  if (watchdog) clearTimeout(watchdog)
  if (smokeFailed) process.exitCode = 1
})

require('../src/main')
