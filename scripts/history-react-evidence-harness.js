'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

async function loadHistoryView (projectRoot) {
  const filename = path.join(projectRoot, 'src', 'history', 'history-view.tsx')
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

async function nextTurn () {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

async function waitFor (probe, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await nextTurn()
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function exerciseBoundedHistoryReact ({ history, pageSize, pageSamples, projectRoot, segmentCount, durationMs }) {
  const HistoryView = await loadHistoryView(projectRoot)
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://history.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event'].map((key) => [key, global[key]]))
  global.window = dom.window; global.document = dom.window.document
  global.HTMLElement = dom.window.HTMLElement; global.Event = dom.window.Event
  global.IS_REACT_ACT_ENVIRONMENT = true
  const collected = []
  dom.window.ManualWindowDrag = { bindManualWindowDrag: () => ({ end () {} }), isInteractiveDragEvent: () => false }
  dom.window.historyApi = {
    close () {}, dragEnd () {}, dragStart () {}, onConfig: () => () => {},
    async getConfig () { return { theme: 'dark', systemDark: true } },
    async listSessions (limit, cursor) { return { ok: true, value: await history.listSessions({ limit, cursor }) } },
    async getSessionPage (sessionId, limit, cursor) {
      const started = process.hrtime.bigint()
      const page = await history.getSessionPage({ sessionId, limit, cursor })
      pageSamples.push(durationMs(started)); collected.push(...page.items)
      return { ok: true, value: page }
    },
    async exportSession () { return { ok: true, value: { status: 'cancelled' } } }
  }
  const reactRoot = createRoot(document.getElementById('root'))
  let maxNodes = 0
  try {
    await act(async () => reactRoot.render(React.createElement(HistoryView)))
    const sessionCard = await waitFor(() => document.querySelector('[data-session-id]'), 'history session list')
    await act(async () => sessionCard.click())
    const expectedPageCount = Math.ceil(segmentCount / pageSize)
    for (let pageIndex = 0; pageIndex < expectedPageCount; pageIndex += 1) {
      const expectedItemCount = Math.min(pageSize, segmentCount - pageIndex * pageSize)
      await waitFor(() => document.querySelector('#timeline')?.getAttribute('aria-busy') === 'false' &&
        document.querySelectorAll('#timeline .timeline-item').length === expectedItemCount, `history React page ${pageIndex + 1}`)
      maxNodes = Math.max(maxNodes, document.querySelectorAll('#timeline .timeline-item').length)
      if (pageIndex + 1 < expectedPageCount) {
        const next = document.getElementById('nextPage')
        if (next.disabled) throw new Error('history React renderer ended before all fixture pages were loaded')
        await act(async () => next.click())
      }
    }
    if (!document.getElementById('nextPage').disabled || document.getElementById('previousPage').disabled) {
      throw new Error('history React pagination controls did not reach the terminal page')
    }
    if (collected.length !== segmentCount || new Set(collected.map((item) => item.segmentId)).size !== segmentCount) {
      throw new Error('history React pagination lost or duplicated fixture segments')
    }
    return { historyPageCount: expectedPageCount, maxNodes, collected }
  } finally {
    await act(async () => reactRoot.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    delete global.IS_REACT_ACT_ENVIRONMENT
  }
}

module.exports = { exerciseBoundedHistoryReact }
