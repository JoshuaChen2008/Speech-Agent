'use strict'

;(function exposeManualWindowDrag (global) {
  const INTERACTIVE_DRAG_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'select',
    'textarea',
    'summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="textbox"]',
    '[tabindex]:not([tabindex="-1"])',
    '[data-no-drag]'
  ].join(', ')

  function callSafely (callback, ...args) {
    if (typeof callback !== 'function') return undefined
    try { return callback(...args) } catch { return undefined }
  }

  function startSafely (callback, event) {
    if (typeof callback !== 'function') return true
    try { return callback(event) !== false } catch { return false }
  }

  function isInteractiveDragEvent (event) {
    const path = typeof event?.composedPath === 'function'
      ? event.composedPath()
      : [event?.target]
    return path.some((node) => {
      if (!node || typeof node.matches !== 'function') return false
      try { return node.matches(INTERACTIVE_DRAG_SELECTOR) } catch { return true }
    })
  }

  function bindManualWindowDrag ({
    handle,
    classTarget = handle,
    className = 'dragging',
    canStart,
    onStart,
    onEnd,
    onActiveChange
  }) {
    if (!handle || typeof handle.addEventListener !== 'function') {
      throw new TypeError('manual drag handle is required')
    }

    let activePointerId = null

    function finish (event, notifyEnd) {
      if (activePointerId === null) return
      if (event && Number.isInteger(event.pointerId) && event.pointerId !== activePointerId) return

      const pointerId = activePointerId
      activePointerId = null
      try { handle.releasePointerCapture?.(pointerId) } catch { /* optional browser preview */ }
      classTarget?.classList?.remove(className)
      if (notifyEnd) callSafely(onEnd, event)
      callSafely(onActiveChange, false, event)
    }

    function end (event) { finish(event, true) }
    function cancel () { finish(undefined, false) }

    function start (event) {
      if (!event || event.button !== 0 || event.isPrimary === false ||
          !Number.isInteger(event.pointerId)) return
      if (activePointerId !== null) {
        if (event.pointerId !== activePointerId) return
        /* Mouse pointer ids are normally reused. Seeing the same primary id in
           a new pointerdown means the previous sequence ended outside this
           renderer; close that local/main state before accepting this press. */
        finish(undefined, true)
      }
      if (!startSafely(canStart, event)) return
      if (!startSafely(onStart, event)) return

      activePointerId = event.pointerId
      classTarget?.classList?.add(className)
      callSafely(onActiveChange, true, event)
      try {
        handle.setPointerCapture(event.pointerId)
        if (event.isTrusted !== false && typeof handle.hasPointerCapture === 'function' &&
            !handle.hasPointerCapture(event.pointerId)) {
          end(event)
        }
      } catch {
        /* An active main-process timer without pointer capture can outlive mouseup
           when the pointer crosses into another overlay HWND. Fail closed for real
           input; qualification's untrusted DOM events cannot own native capture. */
        if (event.isTrusted !== false) end(event)
      }
    }

    handle.addEventListener('pointerdown', start)
    global.addEventListener('pointerup', end)
    global.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
    global.addEventListener('blur', end)
    global.addEventListener('beforeunload', end)

    return Object.freeze({
      cancel,
      end,
      isDragging: () => activePointerId !== null
    })
  }

  global.ManualWindowDrag = Object.freeze({
    INTERACTIVE_DRAG_SELECTOR,
    bindManualWindowDrag,
    isInteractiveDragEvent
  })
})(window)
