'use strict'

const WINDOW_LAYOUT = Object.freeze({
  captionMargin: 20,
  toolbarMargin: 16,
  toolbarDockInset: 20,
  toolbarViewportWidth: 600,
  toolbarViewportHeight: 72
})

const FALLBACK_OVERLAP_RECT = Object.freeze({
  top: 0,
  right: 0,
  /* The widest real contour spans window-local 16..584. With the 20 DIP
     dock inset its card-local left edge is 588 DIP from card-right. */
  width: 588,
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
     never requires a per-tick stream of layout reports. */
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

function toolbarDockBoundsFor (captionBounds) {
  const cardRight = captionBounds.x + captionBounds.width - WINDOW_LAYOUT.captionMargin
  const cardTop = captionBounds.y + WINDOW_LAYOUT.captionMargin
  return {
    x: Math.round(cardRight - WINDOW_LAYOUT.toolbarDockInset -
      (WINDOW_LAYOUT.toolbarViewportWidth - WINDOW_LAYOUT.toolbarMargin)),
    y: Math.round(cardTop + WINDOW_LAYOUT.toolbarDockInset - WINDOW_LAYOUT.toolbarMargin),
    width: WINDOW_LAYOUT.toolbarViewportWidth,
    height: WINDOW_LAYOUT.toolbarViewportHeight
  }
}

function captionNativeHitAt ({ captionBounds, toolbarOverlapRect, pointer, locked }) {
  const validCaptionBounds = isExactObject(captionBounds, ['x', 'y', 'width', 'height']) &&
    [captionBounds.x, captionBounds.y, captionBounds.width, captionBounds.height].every(Number.isFinite) &&
    captionBounds.width > WINDOW_LAYOUT.captionMargin * 2 &&
    captionBounds.height > WINDOW_LAYOUT.captionMargin * 2
  const validOverlap = isExactObject(toolbarOverlapRect, ['top', 'right', 'width', 'height']) &&
    [toolbarOverlapRect.top, toolbarOverlapRect.right,
      toolbarOverlapRect.width, toolbarOverlapRect.height].every(Number.isFinite) &&
    toolbarOverlapRect.top >= 0 && toolbarOverlapRect.right >= 0 &&
    toolbarOverlapRect.width > 0 && toolbarOverlapRect.height > 0
  const validPointer = isExactObject(pointer, ['x', 'y']) &&
    Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
  if (!validCaptionBounds || !validOverlap || !validPointer || typeof locked !== 'boolean') {
    throw new TypeError('caption native hit geometry is invalid')
  }
  if (locked) return false

  const card = {
    left: captionBounds.x + WINDOW_LAYOUT.captionMargin,
    top: captionBounds.y + WINDOW_LAYOUT.captionMargin,
    right: captionBounds.x + captionBounds.width - WINDOW_LAYOUT.captionMargin,
    bottom: captionBounds.y + captionBounds.height - WINDOW_LAYOUT.captionMargin
  }
  if (pointer.x < card.left || pointer.x >= card.right ||
      pointer.y < card.top || pointer.y >= card.bottom) return false

  /* Match .tb-hole exactly: right anchoring plus max-width clipping against
     the caption card. This is the same overlap already sent to the renderer,
     not a second toolbar geometry source. */
  const cardWidth = card.right - card.left
  const holeWidth = Math.min(
    toolbarOverlapRect.width,
    Math.max(0, cardWidth - toolbarOverlapRect.right)
  )
  if (holeWidth <= 0) return true
  const holeRight = card.right - toolbarOverlapRect.right
  const hole = {
    left: holeRight - holeWidth,
    top: card.top + toolbarOverlapRect.top,
    right: holeRight,
    bottom: card.top + toolbarOverlapRect.top + toolbarOverlapRect.height
  }
  const insideToolbarOverlap = pointer.x >= hole.left && pointer.x < hole.right &&
    pointer.y >= hole.top && pointer.y < hole.bottom
  return !insideToolbarOverlap
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
  captionNativeHitAt,
  dragBoundsAt,
  projectToolbarReport,
  toolbarDockBoundsFor
}
