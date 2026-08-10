'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

function read (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('SEM-F22/J17: toolbar reports only the existing toolbar contour after obtaining a generation', () => {
  const preload = read('src/preload/toolbar.js')
  const renderer = read('src/toolbar/toolbar.ts')

  assert.match(preload, /getToolbarLayoutContext: \(\) => ipcRenderer\.invoke\(CHANNELS\.TOOLBAR_LAYOUT_GET_CONTEXT\)/)
  assert.match(preload, /reportToolbarLayout: \(report\) => ipcRenderer\.send\(CHANNELS\.TOOLBAR_LAYOUT_REPORT_RECT, report\)/)
  assert.match(renderer, /new ResizeObserver/)
  assert.match(renderer, /toolbar\.getBoundingClientRect\(\)/)
  assert.match(renderer, /bridge\.getToolbarLayoutContext\(\)/)
  assert.match(renderer, /bridge\.reportToolbarLayout\(/)
  assert.doesNotMatch(renderer, /document\.querySelector\(['"]\.bar['"]\)/)
})

test('SEM-F22/J17: caption receives a bounded overlap and immediately refreshes hit testing', () => {
  const preload = read('src/preload/caption.js')
  const renderer = read('src/caption/caption.ts')
  const styles = read('src/caption/caption.css')

  assert.match(preload, /onToolbarOverlap: \(callback\) => subscribe\(CHANNELS\.CAPTION_LAYOUT_TOOLBAR_OVERLAP, callback\)/)
  assert.match(renderer, /bridge\.onToolbarOverlap\(/)
  assert.match(renderer, /--toolbar-overlap-top/)
  assert.match(renderer, /--toolbar-overlap-right/)
  assert.match(renderer, /--toolbar-overlap-width/)
  assert.match(renderer, /--toolbar-overlap-height/)
  assert.match(renderer, /applyHit\(lastX, lastY\)/)
  assert.match(styles, /top: var\(--toolbar-overlap-top, 0px\)/)
  assert.match(styles, /right: var\(--toolbar-overlap-right, 0px\)/)
  assert.match(styles, /width: var\(--toolbar-overlap-width, 588px\)/)
  assert.match(styles, /height: var\(--toolbar-overlap-height, 64px\)/)
  assert.match(styles, /max-width: max\(0px, calc\(100% - var\(--toolbar-overlap-right, 0px\)\)\)/)
  assert.doesNotMatch(styles, /max-width: 100%/)
})
