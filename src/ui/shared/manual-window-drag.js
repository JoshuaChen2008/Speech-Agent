'use strict'

;(function exposeManualWindowDrag (global) {
  function callSafely (callback, ...args) {
    if (typeof callback !== 'function') return undefined
    try { return callback(...args) } catch { return undefined }
  }

  function startSafely (callback, event) {
    if (typeof callback !== 'function') return true
    try { return callback(event) !== false } catch { return false }
  }

  function bindManualWindowDrag ({
    handle,
    classTarget = handle,
    className = 'dragging',
    onStart,
    onEnd,
    onActiveChange
  }) {
    if (!handle || typeof handle.addEventListener !== 'function') {
      throw new TypeError('manual drag handle is required')
    }

    let activePointerId = null

    function end (event) {
      if (activePointerId === null) return
      if (event && Number.isInteger(event.pointerId) && event.pointerId !== activePointerId) return

      activePointerId = null
      classTarget?.classList?.remove(className)
      callSafely(onEnd, event)
      callSafely(onActiveChange, false, event)
    }

    function start (event) {
      if (!event || event.button !== 0 || event.isPrimary === false ||
          !Number.isInteger(event.pointerId) || activePointerId !== null) return
      if (!startSafely(onStart, event)) return

      activePointerId = event.pointerId
      classTarget?.classList?.add(className)
      callSafely(onActiveChange, true, event)
      try { handle.setPointerCapture(event.pointerId) } catch { /* optional browser preview */ }
    }

    handle.addEventListener('pointerdown', start)
    global.addEventListener('pointerup', end)
    global.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
    global.addEventListener('blur', end)
    global.addEventListener('beforeunload', end)

    return Object.freeze({
      end,
      isDragging: () => activePointerId !== null
    })
  }

  global.ManualWindowDrag = Object.freeze({ bindManualWindowDrag })
})(window)
