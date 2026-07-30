'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..', '..')

function source (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

class FakeElement {
  constructor (tagName = 'div') {
    this.tagName = tagName.toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.dataset = {}
    this.disabled = false
    this.hidden = false
    this.listeners = new Map()
    this._textContent = ''
    this.classList = { add () {}, remove () {} }
  }

  get textContent () { return this._textContent }

  set textContent (value) {
    this._textContent = String(value)
    if (value === '') this.children = []
  }

  appendChild (child) {
    this.children.push(child)
    return child
  }

  setAttribute (name, value) { this.attributes.set(name, String(value)) }

  getAttribute (name) { return this.attributes.get(name) ?? null }

  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }

  click () {
    for (const callback of this.listeners.get('click') || []) callback({ target: this })
  }

  closest () { return null }

  setPointerCapture () {}
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function flushRenderer () {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createHistoryHarness () {
  const ids = [
    'titlebar', 'close', 'refresh', 'globalStatus', 'sessionCount', 'sessionList',
    'loadMore', 'emptyState', 'sessionDetail', 'detailSource', 'detailTitle',
    'detailMeta', 'exportStatus', 'previousPage', 'nextPage', 'retryPage',
    'rangeStatus', 'timeline'
  ]
  const elements = new Map(ids.map((id) => [id, new FakeElement(id.includes('Page') ? 'button' : 'div')]))
  elements.get('sessionDetail').hidden = true
  elements.get('loadMore').hidden = true
  elements.get('retryPage').hidden = true
  const exportButtons = ['txt', 'md', 'srt'].map((format) => {
    const button = new FakeElement('button')
    button.dataset.export = format
    return button
  })
  const pageRequests = []
  const exportRequests = []
  const sessions = [
    { sessionId: 'session-a', sourceId: 'mic', state: 'closed', startedAt: 1_000, endedAt: 5_000, segmentCount: 2 },
    { sessionId: 'session-b', sourceId: 'loopback', state: 'closed', startedAt: 10_000, endedAt: 20_000, segmentCount: 51 }
  ]
  const historyApi = {
    dragStart () {},
    dragEnd () {},
    close () {},
    onConfig () {},
    getConfig: async () => ({ theme: 'dark', systemDark: true }),
    listSessions: async () => ({ ok: true, value: { items: sessions, nextCursor: null } }),
    getSessionPage (sessionId, limit, cursor) {
      const request = deferred()
      pageRequests.push({ cursor, limit, request, sessionId })
      return request.promise
    },
    exportSession (sessionId, format) {
      const request = deferred()
      exportRequests.push({ format, request, sessionId })
      return request.promise
    }
  }
  const document = {
    documentElement: new FakeElement('html'),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === '[data-export]' ? exportButtons : []
  }
  document.documentElement.dataset = {}
  const window = { addEventListener () {}, historyApi }
  vm.runInNewContext(source('src/history/history.js'), {
    Date,
    Intl,
    console,
    document,
    window
  })
  return { elements, exportButtons, exportRequests, pageRequests, sessions }
}

function pageValue (session, totalCount, items, nextCursor) {
  return { ok: true, value: { session, totalCount, items, nextCursor } }
}

function segment (prefix, index, sourceId = 'loopback') {
  return {
    segmentId: `${prefix}-${index}`,
    sourceId,
    text: `${prefix} 字幕 ${index}`,
    textRevision: 1,
    t0Ms: index * 1_000,
    t1Ms: index * 1_000 + 800
  }
}

test('history window exposes terminal text review and txt/md/srt export without audio controls', () => {
  const html = source('src/history/index.html')
  const script = source('src/history/history.js')

  assert.match(html, /id="sessionList"[^>]+role="list"/)
  assert.match(html, /id="previousPage"[^>]*>上一批</)
  assert.match(html, /id="nextPage"[^>]*>下一批</)
  assert.match(html, /id="retryPage"[^>]+hidden[^>]*>重试</)
  assert.match(html, /id="rangeStatus"[^>]+role="status"[^>]+aria-live="polite"/)
  assert.match(html, /id="timeline"[^>]+role="list"[^>]+tabindex="0"[\s\S]+aria-busy="false"/)
  assert.match(html, /data-export="txt"/)
  assert.match(html, /data-export="md"/)
  assert.match(html, /data-export="srt"/)
  assert.match(html, /文本复盘，不包含录音/)
  assert.match(html, /临时字幕、译文和音频都不会进入历史/)
  assert.doesNotMatch(html, /<audio\b|\bplayback\b|data-action="play"/i)

  assert.match(script, /api\.listSessions\(PAGE_SIZE,/)
  assert.match(script, /const PAGE_SIZE = 50/)
  assert.match(script, /api\.getSessionPage\(sessionId, PAGE_SIZE, cursorEntry\.cursor\)/)
  assert.doesNotMatch(script, /api\.getSession\(/)
  assert.match(script, /value\.items\.length > PAGE_SIZE/)
  assert.match(script, /detailCursorStack\.push\(/)
  assert.match(script, /generation !== detailGeneration \|\| sessionId !== selectedSessionId/)
  assert.match(script, /api\.exportSession\(sessionId, format\)/)
  assert.match(script, /request !== exportRequest \|\| generation !== detailGeneration \|\| sessionId !== selectedSessionId/)
  assert.match(script, /listItem\.setAttribute\('role', 'listitem'\)/)
  assert.match(script, /item\.setAttribute\('aria-posinset'/)
  assert.match(script, /item\.setAttribute\('aria-setsize'/)
  assert.match(script, /timeline\.setAttribute\('aria-busy', 'true'\)/)
  assert.match(script, /sessionButtons\.get\(selectedSessionId\)\?\.setAttribute\('aria-current'/)
  assert.doesNotMatch(script, /audioPath|translation\s*[.:[]|require\(['"](?:node:)?fs|require\(['"]electron/)
})

test('history detail keeps one bounded page and rejects late page or export results', async () => {
  const harness = createHistoryHarness()
  await flushRenderer()

  const sessionList = harness.elements.get('sessionList')
  const timeline = harness.elements.get('timeline')
  const rangeStatus = harness.elements.get('rangeStatus')
  const sessionACard = sessionList.children[0].children[0]
  const sessionBCard = sessionList.children[1].children[0]

  sessionACard.click()
  sessionBCard.click()
  assert.equal(harness.pageRequests.length, 2)
  assert.equal(harness.pageRequests[0].sessionId, 'session-a')
  assert.equal(harness.pageRequests[1].sessionId, 'session-b')
  assert.equal(harness.pageRequests[1].limit, 50)
  assert.equal(sessionACard.getAttribute('aria-current'), 'false')
  assert.equal(sessionBCard.getAttribute('aria-current'), 'true')

  const firstBatch = Array.from({ length: 50 }, (_, index) => segment('b', index))
  harness.pageRequests[1].request.resolve(pageValue(
    harness.sessions[1],
    51,
    firstBatch,
    { t0Ms: 49_000, firstEventOrder: 50 }
  ))
  await flushRenderer()
  assert.equal(timeline.children.length, 50)
  assert.equal(timeline.children[0].children[1].textContent, 'b 字幕 0')
  assert.equal(timeline.children[49].getAttribute('aria-posinset'), '50')
  assert.equal(timeline.children[49].getAttribute('aria-setsize'), '51')
  assert.equal(rangeStatus.textContent, '第 1–50 条，共 51 条')
  assert.equal(harness.elements.get('nextPage').disabled, false)
  assert.equal(timeline.getAttribute('aria-busy'), 'false')

  harness.pageRequests[0].request.resolve(pageValue(
    harness.sessions[0],
    2,
    [segment('late-a', 0, 'mic'), segment('late-a', 1, 'mic')],
    null
  ))
  await flushRenderer()
  assert.equal(timeline.children.length, 50)
  assert.equal(timeline.children[0].children[1].textContent, 'b 字幕 0')

  harness.elements.get('nextPage').click()
  assert.equal(harness.pageRequests[2].cursor.firstEventOrder, 50)
  harness.pageRequests[2].request.resolve(pageValue(
    harness.sessions[1],
    51,
    [segment('b', 50)],
    null
  ))
  await flushRenderer()
  assert.equal(timeline.children.length, 1)
  assert.equal(timeline.children[0].getAttribute('aria-posinset'), '51')
  assert.equal(rangeStatus.textContent, '第 51–51 条，共 51 条')
  assert.equal(harness.elements.get('previousPage').disabled, false)
  assert.equal(harness.elements.get('nextPage').disabled, true)

  harness.elements.get('previousPage').click()
  assert.equal(harness.pageRequests[3].cursor, null)
  harness.pageRequests[3].request.resolve(pageValue(
    harness.sessions[1],
    51,
    firstBatch,
    { t0Ms: 49_000, firstEventOrder: 50 }
  ))
  await flushRenderer()
  assert.equal(timeline.children.length, 50)

  harness.exportButtons[0].click()
  assert.equal(harness.exportRequests[0].sessionId, 'session-b')
  assert.equal(harness.elements.get('exportStatus').textContent, '正在准备导出…')
  sessionACard.click()
  harness.pageRequests[4].request.resolve(pageValue(
    harness.sessions[0],
    2,
    [segment('a', 0, 'mic'), segment('a', 1, 'mic')],
    null
  ))
  await flushRenderer()
  harness.exportRequests[0].request.resolve({ ok: true, value: { status: 'saved' } })
  await flushRenderer()
  assert.equal(timeline.children[0].children[1].textContent, 'a 字幕 0')
  assert.equal(harness.elements.get('exportStatus').textContent, '')

  sessionBCard.click()
  harness.pageRequests[5].request.resolve({ ok: false, error: { message: '分页读取失败' } })
  await flushRenderer()
  assert.equal(harness.elements.get('retryPage').hidden, false)
  assert.equal(rangeStatus.textContent, '读取失败，请重试')
  harness.elements.get('retryPage').click()
  harness.pageRequests[6].request.resolve(pageValue(harness.sessions[1], 1, [segment('retry-b', 0)], null))
  await flushRenderer()
  assert.equal(harness.elements.get('retryPage').hidden, true)
  assert.equal(timeline.children.length, 1)
  assert.equal(timeline.children[0].children[1].textContent, 'retry-b 字幕 0')
})

test('history preload is a narrow IPC façade without SQL, arbitrary paths or filesystem powers', () => {
  const preload = source('src/preload/history.js')
  const toolbar = source('src/toolbar/toolbar.js')

  assert.match(preload, /HISTORY_LIST/)
  assert.match(preload, /HISTORY_PAGE/)
  assert.doesNotMatch(preload, /HISTORY_GET|getSession:\s*/)
  assert.match(preload, /HISTORY_EXPORT/)
  assert.match(preload, /sessionId: String/)
  assert.match(preload, /limit: Number/)
  assert.match(preload, /t0Ms: Number\(cursor\?\.t0Ms\)/)
  assert.match(preload, /firstEventOrder: Number\(cursor\?\.firstEventOrder\)/)
  assert.match(preload, /format: String/)
  assert.doesNotMatch(preload, /filePath|databasePath|\bsql\b|readFile|writeFile|showSaveDialog/i)
  assert.match(toolbar, /history: \(\) => bridge\.action\('history'\)/)
  assert.match(toolbar, /act: 'history'.+label: '历史记录'/)
})
