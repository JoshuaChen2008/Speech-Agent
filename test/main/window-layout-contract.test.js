'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

test('SEM-F22/J17: toolbar layout state starts fail-safe and invalidation advances its generation', () => {
  const {
    FALLBACK_OVERLAP_RECT,
    ToolbarLayoutState
  } = require('../../src/main/window-layout-contract')

  const state = new ToolbarLayoutState()
  assert.deepEqual(state.getContext(), { generation: 1 })
  assert.deepEqual(state.getOverlap(), {
    generation: 1,
    source: 'fallback',
    rect: FALLBACK_OVERLAP_RECT
  })

  assert.deepEqual(state.invalidate(), {
    generation: 2,
    source: 'fallback',
    rect: FALLBACK_OVERLAP_RECT
  })
  assert.deepEqual(state.getContext(), { generation: 2 })
})

test('SEM-F22/J17: valid toolbar CSS geometry becomes an outward-rounded card-local right anchor', () => {
  const { ToolbarLayoutState } = require('../../src/main/window-layout-contract')
  const state = new ToolbarLayoutState()

  assert.deepEqual(state.acceptReport({
    generation: 1,
    rect: { x: 184.2, y: 15.2, width: 399.6, height: 40.3 }
  }), {
    generation: 1,
    source: 'toolbar',
    rect: { top: 11, right: 12, width: 400, height: 41 }
  })

  assert.deepEqual(state.getOverlap(), {
    generation: 1,
    source: 'toolbar',
    rect: { top: 11, right: 12, width: 400, height: 41 }
  })
})

test('SEM-F22/J17: malformed, out-of-bounds and stale toolbar reports fail closed', () => {
  const { FALLBACK_OVERLAP_RECT, ToolbarLayoutState } = require('../../src/main/window-layout-contract')
  const invalidReports = [
    null,
    {},
    { generation: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, extra: true },
    { generation: 1, rect: { x: 0, y: 0, width: 1 } },
    { generation: 1, rect: { x: 0, y: 0, width: 1, height: 1, extra: true } },
    { generation: 0, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { generation: 2, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { generation: 1, rect: { x: -1, y: 0, width: 1, height: 1 } },
    { generation: 1, rect: { x: 0, y: 0, width: 0, height: 1 } },
    { generation: 1, rect: { x: 0, y: 0, width: Number.NaN, height: 1 } },
    { generation: 1, rect: { x: 599, y: 0, width: 2, height: 1 } },
    { generation: 1, rect: { x: 0, y: 71, width: 1, height: 2 } }
  ]

  for (const report of invalidReports) {
    const state = new ToolbarLayoutState()
    assert.deepEqual(state.acceptReport(report), {
      generation: 1,
      source: 'fallback',
      rect: FALLBACK_OVERLAP_RECT
    })
  }
})

test('SEM-F22/J17: main owns generation lifecycle and fixed role-scoped layout channels', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8')
  const channels = require('../../src/main/ipc/channels')
  const { isRoleAllowed } = require('../../src/main/ipc/access-policy')

  assert.equal(channels.TOOLBAR_LAYOUT_GET_CONTEXT, 'toolbar-layout:get-context')
  assert.equal(channels.TOOLBAR_LAYOUT_REPORT_RECT, 'toolbar-layout:report-rect')
  assert.equal(channels.CAPTION_LAYOUT_TOOLBAR_OVERLAP, 'caption-layout:toolbar-overlap')
  assert.equal(isRoleAllowed(channels.TOOLBAR_LAYOUT_GET_CONTEXT, 'toolbar'), true)
  assert.equal(isRoleAllowed(channels.TOOLBAR_LAYOUT_REPORT_RECT, 'toolbar'), true)
  assert.equal(isRoleAllowed(channels.TOOLBAR_LAYOUT_GET_CONTEXT, 'caption'), false)
  assert.equal(isRoleAllowed(channels.TOOLBAR_LAYOUT_REPORT_RECT, 'caption'), false)

  assert.match(main, /did-start-navigation/)
  assert.match(main, /render-process-gone/)
  assert.match(main, /CHANNELS\.TOOLBAR_LAYOUT_GET_CONTEXT/)
  assert.match(main, /CHANNELS\.TOOLBAR_LAYOUT_REPORT_RECT/)
  assert.match(main, /CHANNELS\.CAPTION_LAYOUT_TOOLBAR_OVERLAP/)
})

test('SEM-F22/J17: an unchanged system pointer preserves bounds and the first delta projects immediately', () => {
  const { dragBoundsAt } = require('../../src/main/window-layout-contract')
  const start = { x: 100, y: 70, width: 920, height: 190 }
  const origin = { x: 240, y: 120 }

  assert.deepEqual(dragBoundsAt(start, origin, origin), start)
  assert.deepEqual(dragBoundsAt(start, origin, { x: 241, y: 118 }), {
    x: 101,
    y: 68,
    width: 920,
    height: 190
  })

  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8')
  assert.match(main, /const nextBounds = dragBoundsAt\(state\.start, state\.origin, point\)/)
  assert.match(main, /if \(!sameBounds\(nextBounds, state\.lastBounds\)\) \{[\s\S]*state\.win\.setBounds\(nextBounds\)/)
})
