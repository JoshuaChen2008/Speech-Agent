'use strict'

const WINDOW_LAYOUT = Object.freeze({
  captionMargin: 20,
  toolbarMargin: 16,
  toolbarDockInset: 12,
  toolbarViewportWidth: 600,
  toolbarViewportHeight: 72
})

const FALLBACK_OVERLAP_RECT = Object.freeze({
  top: 0,
  right: 0,
  width: 584,
  height: 64
})

function isExactObject (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isGeneration (value) {
  return Number.isSafeInteger(value) && value > 0
}

function fallbackOverlap (generation) {
  return {
    generation,
    source: 'fallback',
    rect: { ...FALLBACK_OVERLAP_RECT }
  }
}

function cloneOverlap (overlap) {
  return {
    generation: overlap.generation,
    source: overlap.source,
    rect: { ...overlap.rect }
  }
}

function projectToolbarReport (report, expectedGeneration) {
  if (!isExactObject(report, ['generation', 'rect']) ||
      report.generation !== expectedGeneration ||
      !isGeneration(report.generation) ||
      !isExactObject(report.rect, ['x', 'y', 'width', 'height'])) return null

  const { x, y, width, height } = report.rect
  if (![x, y, width, height].every(Number.isFinite) ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > WINDOW_LAYOUT.toolbarViewportWidth ||
      y + height > WINDOW_LAYOUT.toolbarViewportHeight) return null

  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.ceil(x + width)
  const bottom = Math.ceil(y + height)
  const roundedWidth = right - left
  const roundedHeight = bottom - top

  /* dock() positions the toolbar viewport relative to the caption card. Keep
     the overlap anchored to the card's top/right edges so caption resizing
     never requires an 8ms stream of layout reports. */
  const rawTop = WINDOW_LAYOUT.toolbarDockInset - WINDOW_LAYOUT.toolbarMargin + top
  const rawRight = WINDOW_LAYOUT.toolbarDockInset +
    (WINDOW_LAYOUT.toolbarViewportWidth - WINDOW_LAYOUT.toolbarMargin - right)
  const clippedTop = Math.max(0, rawTop)
  const clippedRight = Math.max(0, rawRight)
  const clippedWidth = roundedWidth - Math.max(0, -rawRight)
  const clippedHeight = roundedHeight - Math.max(0, -rawTop)
  if (clippedWidth <= 0 || clippedHeight <= 0) return null

  return {
    generation: report.generation,
    source: 'toolbar',
    rect: {
      top: clippedTop,
      right: clippedRight,
      width: clippedWidth,
      height: clippedHeight
    }
  }
}

function dragBoundsAt (start, origin, point) {
  return {
    x: start.x + point.x - origin.x,
    y: start.y + point.y - origin.y,
    width: start.width,
    height: start.height
  }
}

class ToolbarLayoutState {
  constructor () {
    this.generation = 1
    this.overlap = fallbackOverlap(this.generation)
  }

  getContext () {
    return { generation: this.generation }
  }

  getOverlap () {
    return cloneOverlap(this.overlap)
  }

  invalidate () {
    this.generation = this.generation === Number.MAX_SAFE_INTEGER ? 1 : this.generation + 1
    this.overlap = fallbackOverlap(this.generation)
    return this.getOverlap()
  }

  acceptReport (report) {
    this.overlap = projectToolbarReport(report, this.generation) || fallbackOverlap(this.generation)
    return this.getOverlap()
  }
}

module.exports = {
  FALLBACK_OVERLAP_RECT,
  ToolbarLayoutState,
  WINDOW_LAYOUT,
  dragBoundsAt,
  projectToolbarReport
}
