'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

const root = path.resolve(__dirname, '..', '..')

function source (relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }

async function loadHistoryView () {
  const filename = path.join(root, 'src', 'history', 'history-view.tsx')
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

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, reject, resolve }
}

function refinement (segmentCount, refinedSegmentCount, options = {}) {
  return {
    segmentCount,
    refinedSegmentCount,
    refinementEnabled: true,
    refinementFaultCode: options.refinementFaultCode ?? null,
    refinementResultStatus: options.refinementResultStatus ?? 'known'
  }
}

function segment (prefix, index, sourceId = 'loopback') {
  return {
    segmentId: `${prefix}-${index}`,
    sourceId,
    text: `${prefix} 字幕 ${index}`,
    refinedText: `${prefix} 精修稿 ${index}`,
    textRevision: 1,
    t0Ms: index * 1000,
    t1Ms: index * 1000 + 800
  }
}

function pageValue (session, totalCount, items, nextCursor, pageRefinement = refinement(totalCount, totalCount)) {
  return { ok: true, value: { session, totalCount, items, nextCursor, refinement: pageRefinement } }
}

async function flush () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

async function createHarness () {
  const HistoryView = await loadHistoryView()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://history.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event'].map((key) => [key, global[key]]))
  global.window = dom.window
  global.document = dom.window.document
  global.HTMLElement = dom.window.HTMLElement
  global.Event = dom.window.Event
  global.IS_REACT_ACT_ENVIRONMENT = true
  const pageRequests = []
  const exportRequests = []
  const sessions = [
    { sessionId: 'session-a', sourceId: 'mic', state: 'closed', startedAt: 1000, endedAt: 5000, segmentCount: 2 },
    { sessionId: 'session-b', sourceId: 'loopback', state: 'closed', startedAt: 10000, endedAt: 20000, segmentCount: 51 }
  ]
  let dragBindings = 0
  dom.window.ManualWindowDrag = {
    bindManualWindowDrag ({ handle, canStart, onStart, onEnd }) {
      assert.equal(handle.id, 'titlebar'); assert.equal(typeof canStart, 'function'); assert.equal(typeof onStart, 'function'); assert.equal(typeof onEnd, 'function')
      dragBindings += 1
      return { end () {} }
    },
    isInteractiveDragEvent: () => false
  }
  dom.window.historyApi = {
    close () {}, dragStart () {}, dragEnd () {}, onConfig: () => () => {},
    getConfig: async () => ({ theme: 'dark', systemDark: true }),
    listSessions: async () => ({ ok: true, value: { items: sessions, nextCursor: null } }),
    getSessionPage (sessionId, limit, cursor) {
      const request = deferred(); pageRequests.push({ cursor, limit, request, sessionId }); return request.promise
    },
    exportSession (sessionId, format, version) {
      const request = deferred(); exportRequests.push({ format, request, sessionId, version }); return request.promise
    }
  }
  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => { reactRoot.render(React.createElement(HistoryView)) })
  await flush()
  return {
    dom, dragBindings, exportRequests, pageRequests, sessions,
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    }
  }
}

function click (element) { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }

test('SEM-F07/SEM-F11/J10: React history exposes bounded text review and version-scoped export without audio controls', () => {
  const html = source('src/history/index.html')
  const entry = source('src/history/entry.tsx')
  const view = source('src/history/history-view.tsx')
  assert.match(html, /id="root"/)
  assert.match(html, /<script type="module" src="\.\/entry\.tsx"><\/script>/)
  assert.match(entry, /createRoot[\s\S]*HistoryView/)
  assert.match(view, /const PAGE_SIZE = 50/)
  assert.match(view, /api\.listSessions\(PAGE_SIZE,/)
  assert.match(view, /api\.getSessionPage\(sessionId, PAGE_SIZE, cursorEntry\.cursor\)/)
  assert.match(view, /value\.items\.length > PAGE_SIZE/)
  assert.match(view, /api\.exportSession\(sessionId, format, version\)/)
  assert.match(view, /\[原始版回退\]/)
  assert.match(view, /aria-posinset=/)
  assert.match(view, /aria-setsize=/)
  assert.doesNotMatch(`${html}\n${entry}\n${view}`, /<audio\b|audioPath|require\(['"](?:node:)?fs|require\(['"]electron/i)
})

test('SEM-F11/J10: React history rejects late page and export results while keeping one 50-row page', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  assert.equal(harness.dragBindings, 1)
  const cards = [...document.querySelectorAll('[data-session-id]')]
  assert.equal(cards.length, 2)
  await act(async () => { click(cards[0]); click(cards[1]) })
  assert.equal(harness.pageRequests.length, 2)
  assert.equal(harness.pageRequests[1].limit, 50)
  const firstBatch = Array.from({ length: 50 }, (_, index) => segment('b', index))
  await act(async () => harness.pageRequests[1].request.resolve(pageValue(harness.sessions[1], 51, firstBatch, { t0Ms: 50000, firstEventOrder: 51 })))
  await flush()
  assert.equal(document.querySelectorAll('#timeline .timeline-item').length, 50)
  await act(async () => harness.pageRequests[0].request.resolve(pageValue(harness.sessions[0], 2, [segment('late', 0)], null)))
  await flush()
  assert.equal(document.querySelector('#timeline').textContent.includes('late 字幕'), false)
  assert.equal(document.querySelector('#rangeStatus').textContent, '第 1–50 条，共 51 条')

  await act(async () => click(document.querySelector('[data-export="txt"]')))
  assert.equal(harness.exportRequests[0].sessionId, 'session-b')
  assert.equal(harness.exportRequests[0].version, 'original')
  await act(async () => click(cards[0]))
  await act(async () => harness.exportRequests[0].request.resolve({ ok: true, value: { status: 'saved' } }))
  await flush()
  assert.equal(document.querySelector('#exportStatus').textContent, '')
})

test('SEM-F11/J10: whole-session refinement metadata controls fallback and persists across keyset pages', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const session = harness.sessions[1]
  await act(async () => click(document.querySelector('[data-session-id="session-b"]')))
  const firstItems = Array.from({ length: 50 }, (_, index) => segment('mix', index))
  firstItems[1].refinedText = null
  await act(async () => harness.pageRequests[0].request.resolve(pageValue(session, 51, firstItems,
    { t0Ms: 50000, firstEventOrder: 51 }, refinement(51, 50, { refinementFaultCode: 'worker_exit' }))))
  await flush()
  assert.equal(document.querySelector('#detailRefinement').textContent, '精修进程异常结束；已精修 50/51 段，1 段使用原始版')
  await act(async () => click(document.querySelector('[data-version="refined"]')))
  assert.match(document.querySelector('#timeline').textContent, /\[原始版回退\] mix 字幕 1/)
  await act(async () => click(document.querySelector('#nextPage')))
  assert.equal(harness.pageRequests[1].cursor.t0Ms, 50000)
  await act(async () => harness.pageRequests[1].request.resolve(pageValue(session, 51, [segment('mix', 50)], null,
    refinement(51, 50, { refinementFaultCode: 'worker_exit' }))))
  await flush()
  assert.equal(document.querySelector('[data-version="refined"]').getAttribute('aria-checked'), 'true')
  assert.equal(document.querySelectorAll('#timeline .timeline-item').length, 1)
  assert.equal(document.querySelector('#rangeStatus').textContent, '第 51–51 条，共 51 条')
})

test('SEM-F23/J18: React history exposes a bounded read failure and retries the same authoritative page', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('[data-session-id="session-b"]')))
  assert.equal(harness.pageRequests.length, 1)

  await act(async () => harness.pageRequests[0].request.reject(new Error('controlled history read failure')))
  await flush()
  assert.equal(document.querySelector('#rangeStatus').textContent, '读取失败，请重试')
  assert.equal(document.querySelector('#timeline').getAttribute('aria-busy'), 'false')
  assert.equal(document.querySelector('#retryPage').hidden, false)
  assert.equal(document.querySelectorAll('#timeline .timeline-item').length, 0)

  await act(async () => click(document.querySelector('#retryPage')))
  assert.equal(harness.pageRequests.length, 2)
  assert.equal(harness.pageRequests[1].sessionId, 'session-b')
  assert.equal(harness.pageRequests[1].cursor, null)
  await act(async () => harness.pageRequests[1].request.resolve(
    pageValue(harness.sessions[1], 1, [segment('retry', 0)], null, refinement(1, 1))
  ))
  await flush()
  assert.equal(document.querySelector('#rangeStatus').textContent, '第 1–1 条，共 1 条')
  assert.equal(document.querySelector('#retryPage').hidden, true)
  assert.equal(document.querySelectorAll('#timeline .timeline-item').length, 1)
})

test('history preload remains a narrow IPC facade', () => {
  const preload = source('src/preload/history.js')
  assert.match(preload, /listSessions/)
  assert.match(preload, /getSessionPage/)
  assert.match(preload, /exportSession/)
  assert.match(preload, /getAgentContextOverview/)
  assert.match(preload, /manageAgentContext/)
  assert.match(preload, /onAgentContextChanged/)
  assert.match(preload, /assertChangedEvent/)
  assert.doesNotMatch(preload, /nodeIntegration|require\(['"](?:node:)?fs|database|sqlite/i)
})
