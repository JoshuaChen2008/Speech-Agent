'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const {
  bindToolbarDockInvariant,
  TOOLBAR_CORRECTION_MAX_MS,
  TOOLBAR_CORRECTION_MAX_WRITES,
  TOOLBAR_CORRECTION_SETTLE_MS,
  toolbarDockInvariantBoundsFor,
  toolbarViewportBoundsFor,
  toolbarWindowViewportBounds
} = require('../../src/main/toolbar-dock-invariant')

function controlledScheduler () {
  let now = 0
  let nextId = 0
  const callbacks = new Map()
  return {
    cancel: (id) => callbacks.delete(id),
    schedule: (callback, delayMs = 0) => {
      const id = ++nextId
      callbacks.set(id, { callback, due: now + delayMs, id })
      return id
    },
    advance: (durationMs) => {
      const target = now + durationMs
      while (true) {
        const entry = [...callbacks.values()]
          .filter((candidate) => candidate.due <= target)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0]
        if (!entry) break
        callbacks.delete(entry.id)
        now = entry.due
        entry.callback()
      }
      now = target
    },
    runAll: () => {
      if (callbacks.size === 0) return
      const due = Math.min(...[...callbacks.values()].map((entry) => entry.due))
      while (true) {
        const entry = [...callbacks.values()]
          .filter((candidate) => candidate.due === due)
          .sort((left, right) => left.id - right.id)[0]
        if (!entry) break
        callbacks.delete(entry.id)
        now = due
        entry.callback()
      }
    },
    size: () => callbacks.size
  }
}

function uncancellableScheduler () {
  const callbacks = []
  return {
    cancel: () => false,
    schedule: (callback, delayMs = 0) => {
      callbacks.push({ callback, delayMs })
      return callbacks.length
    },
    runFirst: (delayMs) => {
      const index = callbacks.findIndex((entry) => entry.delayMs === delayMs)
      assert.notEqual(index, -1, `an uncancellable ${delayMs}ms callback must exist`)
      callbacks.splice(index, 1)[0].callback()
    },
    runAll: () => {
      const pending = callbacks.splice(0)
      for (const { callback } of pending) callback()
    },
    size: () => callbacks.length
  }
}

test('SEM-F22/J17: fixed toolbar viewport preserves an independent locked position', () => {
  const caption = { x: 100, y: 80, width: 920, height: 190 }
  const toolbar = { x: 731, y: 241, width: 603, height: 75 }

  assert.deepEqual(toolbarViewportBoundsFor(toolbar), {
    x: 731, y: 241, width: 600, height: 72
  })
  assert.deepEqual(toolbarDockInvariantBoundsFor({
    captionBounds: caption,
    toolbarBounds: toolbar,
    locked: true
  }), { x: 731, y: 241, width: 600, height: 72 })
  assert.deepEqual(toolbarDockInvariantBoundsFor({
    captionBounds: caption,
    toolbarBounds: toolbar,
    locked: false
  }), { x: 396, y: 104, width: 600, height: 72 })
  assert.throws(() => toolbarDockInvariantBoundsFor({
    captionBounds: caption,
    toolbarBounds: toolbar,
    locked: null
  }), /lock state/)
})

test('SEM-F22/SEM-F24/J17/J19: one-DIP transparent outer-frame rounding cannot become viewport drift', () => {
  const toolbar = new EventEmitter()
  const content = { x: 731, y: 241, width: 600, height: 72 }
  toolbar.outerBounds = { ...content, height: 73 }
  toolbar.contentBounds = { ...content }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.outerBounds })
  toolbar.getContentBounds = () => ({ ...toolbar.contentBounds })
  let corrections = 0
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => ({ ...authoritativeBounds }),
    setDockBounds: () => { corrections += 1 }
  })

  assert.deepEqual(toolbarWindowViewportBounds(toolbar), content)
  toolbar.emit('resize')
  assert.equal(corrections, 0,
    'an exact content viewport cannot enter a correction loop because of an invisible outer DIP')
  assert.deepEqual(binding.getAuthoritativeBounds(), content,
    'outer-frame rounding cannot become the next legal toolbar baseline')
})

test('SEM-F22/SEM-F24/J17/J19: an outer-frame delta above one DIP is not accepted as a stable fixed viewport', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 731, y: 241, width: 600, height: 72 }
  toolbar.outerBounds = { ...expected, height: expected.height + 2 }
  toolbar.contentBounds = { ...expected }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.outerBounds })
  toolbar.getContentBounds = () => ({ ...toolbar.contentBounds })
  let corrections = 0
  const scheduler = controlledScheduler()
  const faults = []
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.contentBounds = { ...bounds }
      toolbar.outerBounds = { ...bounds, height: bounds.height + 2 }
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onFault: (fault) => faults.push(fault)
  })

  toolbar.emit('resize')
  scheduler.advance(TOOLBAR_CORRECTION_MAX_MS)

  assert.equal(corrections, TOOLBAR_CORRECTION_MAX_WRITES)
  assert.deepEqual(faults, [{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }])
  assert.equal(scheduler.size(), 0)
})

test('SEM-F22/J17: unlocked expected bounds follow the caption dock while locked bounds keep the last legal commit', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const caption = { x: 100, y: 80, width: 920, height: 190 }
  const legalDock = toolbarDockInvariantBoundsFor({
    captionBounds: caption,
    toolbarBounds: { x: 0, y: 0, width: 600, height: 72 },
    locked: false
  })
  toolbar.bounds = { ...legalDock, x: legalDock.x - 37, y: legalDock.y + 19 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let locked = false
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => toolbarDockInvariantBoundsFor({
      captionBounds: caption,
      toolbarBounds: authoritativeBounds,
      locked
    }),
    setDockBounds: (bounds) => { toolbar.bounds = { ...bounds } },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel
  })

  assert.deepEqual(binding.getExpectedBounds(), legalDock,
    'an unlocked minimize/lock snapshot cannot preserve a late native toolbar position')
  binding.commitBounds(legalDock)
  locked = true
  toolbar.bounds = { ...legalDock, x: legalDock.x + 41, y: legalDock.y + 23 }
  assert.deepEqual(binding.getExpectedBounds(), legalDock,
    'a locked snapshot keeps the last explicit legal settlement, not the current native read-back')
})

test('SEM-F22/SEM-F24/J17/J19: native toolbar resize is normalized once to the current fixed dock', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 731, y: 241, width: 600, height: 72 }
  toolbar.bounds = { ...expected }
  toolbar.destroyed = false
  toolbar.isDestroyed = () => toolbar.destroyed
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  toolbar.setBounds = (bounds) => {
    toolbar.bounds = { ...bounds }
    toolbar.emit('resize')
  }
  let corrections = 0
  let geometrySettlements = 0
  const scheduler = controlledScheduler()
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => ({ ...authoritativeBounds }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.setBounds(bounds)
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  toolbar.bounds = { x: expected.x - 2, y: expected.y - 3, width: 602, height: 75 }
  toolbar.emit('resize')
  assert.deepEqual(toolbar.getBounds(), expected)
  assert.equal(corrections, 1, 'a correcting resize event cannot recurse')
  assert.equal(geometrySettlements, 0, 'a synchronous read-back is not final native settlement')
  scheduler.runAll()
  assert.equal(geometrySettlements, 1)

  toolbar.emit('resize')
  assert.equal(geometrySettlements, 1, 'unchanged geometry does not request a pointer re-hit')

  toolbar.bounds = { ...expected, x: expected.x + 19, y: expected.y + 11 }
  assert.equal(binding.commitBounds(), true, 'a settled locked grip explicitly commits its independent position')
  scheduler.runAll()
  const moved = toolbar.getBounds()
  toolbar.bounds = { x: moved.x - 1, y: moved.y - 2, width: 601, height: 74 }
  toolbar.emit('resize')
  assert.deepEqual(toolbar.getBounds(), moved)
  scheduler.runAll()
  assert.equal(geometrySettlements, 2)

  binding.unbind()
  toolbar.bounds.width += 1
  toolbar.emit('resize')
  assert.equal(corrections, 2)
  assert.equal(geometrySettlements, 2)
})

test('SEM-F22/J17: pointer re-hit failure cannot turn a successful toolbar correction into a geometry fault', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, width: 604 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  const faults = []
  const scheduler = controlledScheduler()
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => { toolbar.bounds = { ...bounds } },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { throw new Error('rehit unavailable') },
    onFault: (fault) => faults.push(fault)
  })

  toolbar.emit('resize')
  scheduler.runAll()
  assert.deepEqual(toolbar.getBounds(), expected)
  assert.deepEqual(faults, [])
})

test('SEM-F22/J17: asynchronous toolbar correction re-hits only after the native commit is observed', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { x: 17, y: 28, width: 603, height: 75 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let pendingBounds = null
  let geometrySettlements = 0
  const scheduler = controlledScheduler()
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => { pendingBounds = { ...bounds } },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  toolbar.emit('resize')
  assert.deepEqual(pendingBounds, expected)
  assert.equal(geometrySettlements, 0, 'issuing setBounds is not proof of an OS commit')

  toolbar.bounds = { ...pendingBounds }
  toolbar.emit('move')
  assert.equal(geometrySettlements, 0, 'a native event still waits for the bounded stable endpoint')
  scheduler.runAll()
  assert.equal(geometrySettlements, 1, 'a move-only native commit also closes the correction')
  toolbar.emit('resize')
  assert.equal(geometrySettlements, 1)
})

test('SEM-F22/J17: a stale native commit after a synchronous read-back is corrected without pointer movement', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  const scheduler = controlledScheduler()
  toolbar.bounds = { ...expected }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  let geometrySettlements = 0
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => ({ ...authoritativeBounds }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.bounds = { ...bounds }
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  toolbar.bounds = { x: expected.x - 2, y: expected.y - 3, width: 601, height: 74 }
  toolbar.emit('resize')
  assert.deepEqual(toolbar.getBounds(), expected)
  assert.equal(geometrySettlements, 0, 'the first exact read-back must not finish native settlement')
  assert.equal(scheduler.size(), 2, 'quiet and hard-deadline guards remain after a synchronous read-back')

  toolbar.bounds = { ...expected, height: expected.height + 2 }
  scheduler.runAll()
  assert.deepEqual(toolbar.getBounds(), expected)
  assert.equal(corrections, 2, 'the bounded verification repairs a silent late native overwrite')
  assert.equal(geometrySettlements, 0, 'the repair write must itself reach a later stable endpoint')
  assert.equal(scheduler.size(), 2, 'the second write retains quiet and hard-deadline guards')
  scheduler.runAll()
  assert.equal(geometrySettlements, 1)
  assert.equal(scheduler.size(), 0)

  toolbar.bounds = { ...expected, x: expected.x + 41, y: expected.y + 17 }
  binding.commitBounds()
  const newAuthoritative = toolbar.getBounds()
  toolbar.bounds = { ...expected, height: expected.height + 2 }
  scheduler.runAll()
  scheduler.runAll()
  assert.deepEqual(toolbar.getBounds(), {
    ...newAuthoritative,
    width: expected.width,
    height: expected.height
  }, 'a new legal settlement replaces the old correction target')
  assert.equal(TOOLBAR_CORRECTION_SETTLE_MS > 0, true)
})

test('SEM-F22/J17: a legal settlement immediately normalizes a stale fixed viewport before capture', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, height: 74 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let geometrySettlements = 0
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => ({ ...authoritativeBounds }),
    setDockBounds: (bounds) => { toolbar.bounds = { ...bounds } },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  assert.equal(binding.commitBounds(), true)
  assert.deepEqual(toolbar.getBounds(), expected,
    'minimize/lock settlement cannot preserve a visibly expanded toolbar until the timer')
  assert.equal(geometrySettlements, 0)
  scheduler.runAll()
  assert.equal(geometrySettlements, 1, 'pointer re-hit waits for the stable endpoint')
})

test('SEM-F22/J17: a move-only native commit validates size unless a legal grip owns movement', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => ({ ...authoritativeBounds }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.bounds = { ...bounds }
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel
  })

  toolbar.emit('move')
  assert.equal(corrections, 0, 'an ordinary exact move is a strict no-op')
  toolbar.bounds.height += 2
  toolbar.emit('move')
  assert.deepEqual(toolbar.getBounds(), expected,
    'setPosition may carry a stale normal-placement size without a resize event')

  scheduler.runAll()
  binding.suspendCorrection()
  toolbar.bounds = { ...expected, x: expected.x + 19, height: expected.height + 2 }
  toolbar.emit('resize')
  assert.equal(corrections, 1, 'an active legal grip cannot be pulled back by the invariant')
  binding.commitBounds()
  assert.deepEqual(toolbar.getBounds(), {
    x: expected.x + 19,
    y: expected.y,
    width: expected.width,
    height: expected.height
  }, 'grip termination keeps its new position while immediately restoring fixed size')
})

test('SEM-F22/J17: replacement and unbind invalidate uncancellable toolbar verification callbacks', () => {
  const toolbar = new EventEmitter()
  const scheduler = uncancellableScheduler()
  let expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  let geometrySettlements = 0
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.bounds = { ...bounds }
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  toolbar.bounds = { ...expected, height: 74 }
  toolbar.emit('resize')
  expected = { x: 101, y: 202, width: 600, height: 72 }
  toolbar.bounds = { ...expected }
  binding.commitBounds()
  assert.equal(scheduler.size(), 4, 'the fake boundary deliberately keeps both stale guards alive')
  scheduler.runAll()
  assert.deepEqual(toolbar.getBounds(), expected)
  assert.equal(corrections, 1, 'the stale target cannot overwrite a newer legal settlement')
  assert.equal(geometrySettlements, 0, 'a pure legal commit cannot masquerade as a correction')

  toolbar.bounds = { ...expected, height: 74 }
  toolbar.emit('resize')
  const correctionsBeforeUnbind = corrections
  binding.unbind()
  scheduler.runAll()
  assert.equal(corrections, correctionsBeforeUnbind)
  assert.equal(geometrySettlements, 0, 'an uncancellable callback after unbind is inert')
})

test('SEM-F22/J17: an uncancellable old deadline cannot close a changed dock target', () => {
  const toolbar = new EventEmitter()
  const scheduler = uncancellableScheduler()
  let expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, height: 74 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => {
      corrections += 1
      toolbar.bounds = { ...bounds }
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel
  })

  toolbar.emit('resize')
  expected = { x: 90, y: 120, width: 600, height: 72 }
  toolbar.bounds = { ...expected }
  toolbar.emit('move')
  scheduler.runFirst(TOOLBAR_CORRECTION_MAX_MS)
  toolbar.bounds = { ...expected, height: 74 }
  scheduler.runFirst(TOOLBAR_CORRECTION_SETTLE_MS)
  scheduler.runFirst(TOOLBAR_CORRECTION_SETTLE_MS)

  assert.deepEqual(toolbar.getBounds(), expected,
    'the current quiet guard remains active after an old hard deadline fires')
  assert.equal(corrections, 2, 'only the old initial target and current silent overwrite are corrected')
})

test('SEM-F22/SEM-T04/J17: a non-converging toolbar correction stops at the bounded fixed diagnostic', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, height: 74 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  let geometrySettlements = 0
  const faults = []
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: () => { corrections += 1 },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 },
    onFault: (fault) => faults.push(fault)
  })

  toolbar.emit('resize')
  for (let attempt = 0; attempt < TOOLBAR_CORRECTION_MAX_WRITES; attempt += 1) scheduler.runAll()
  assert.equal(corrections, TOOLBAR_CORRECTION_MAX_WRITES)
  assert.equal(scheduler.size(), 0, 'the failed target cannot retain a write loop')
  assert.equal(geometrySettlements, 0)
  assert.deepEqual(faults, [{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }])

  toolbar.emit('resize')
  toolbar.emit('move')
  assert.equal(corrections, TOOLBAR_CORRECTION_MAX_WRITES,
    'tail move/resize events with the same observed geometry cannot reopen the failed target')
  assert.equal(faults.length, 1)

  toolbar.bounds = { ...toolbar.bounds, x: toolbar.bounds.x + 1 }
  toolbar.emit('resize')
  assert.equal(corrections, TOOLBAR_CORRECTION_MAX_WRITES + 1,
    'a later native resize with genuinely different observed geometry starts one fresh bounded retry')
})

test('SEM-F22/SEM-T04/J17: asynchronous move and resize tails cannot restart the same failed correction target', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, height: 74 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let corrections = 0
  const faults = []
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: () => {
      corrections += 1
      scheduler.schedule(() => toolbar.emit('move'), 0)
      scheduler.schedule(() => toolbar.emit('resize'), 0)
    },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onFault: (fault) => faults.push(fault)
  })

  toolbar.emit('resize')
  scheduler.advance(0)
  assert.equal(corrections, 1,
    'one native move+resize tail observes one geometry and consumes only one correction write')
  scheduler.advance(TOOLBAR_CORRECTION_MAX_MS * 2)

  assert.equal(corrections, TOOLBAR_CORRECTION_MAX_WRITES)
  assert.deepEqual(faults, [{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }])
  assert.equal(scheduler.size(), 0)
})

test('SEM-F22/J17: exact native events can reset quiet but cannot extend the hard correction deadline', () => {
  const toolbar = new EventEmitter()
  const scheduler = controlledScheduler()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, height: 74 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  let geometrySettlements = 0
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => { toolbar.bounds = { ...bounds } },
    scheduleVerification: scheduler.schedule,
    cancelVerification: scheduler.cancel,
    onCorrected: () => { geometrySettlements += 1 }
  })

  toolbar.emit('resize')
  let elapsed = 0
  while (elapsed + TOOLBAR_CORRECTION_SETTLE_MS - 1 < TOOLBAR_CORRECTION_MAX_MS) {
    scheduler.advance(TOOLBAR_CORRECTION_SETTLE_MS - 1)
    elapsed += TOOLBAR_CORRECTION_SETTLE_MS - 1
    toolbar.emit('move')
    assert.equal(geometrySettlements, 0, `exact event at ${elapsed}ms only resets quiet`)
  }
  scheduler.advance(TOOLBAR_CORRECTION_MAX_MS - elapsed - 1)
  assert.equal(geometrySettlements, 0, '999ms is still inside the absolute deadline')
  scheduler.advance(1)

  assert.equal(geometrySettlements, 1, 'the absolute deadline closes an exact target once')
  assert.equal(scheduler.size(), 0)
})

test('SEM-F22/SEM-T04/J17: destroyed toolbar and invalid dependencies fail closed', () => {
  const toolbar = new EventEmitter()
  toolbar.destroyed = true
  toolbar.isDestroyed = () => true
  toolbar.getBounds = () => ({ x: 0, y: 0, width: 601, height: 74 })
  let corrections = 0
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ x: 0, y: 0, width: 600, height: 72 }),
    setDockBounds: () => { corrections += 1 }
  })
  toolbar.emit('resize')
  assert.equal(corrections, 0)
  assert.throws(() => bindToolbarDockInvariant({}), /dependencies/)
})

test('SEM-F22 / J17-J19 routes managed restore writes through the suspended dock coordinator', () => {
  const toolbar = new EventEmitter()
  const expected = { x: 20, y: 30, width: 600, height: 72 }
  toolbar.bounds = { ...expected, width: 602 }
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ ...toolbar.bounds })
  const writes = []
  const binding = bindToolbarDockInvariant({
    toolbar,
    getDockBounds: () => ({ ...expected }),
    setDockBounds: (bounds) => {
      writes.push({ ...bounds })
      toolbar.bounds = { ...bounds }
    }
  })

  binding.suspendCorrection()
  assert.equal(binding.writeBounds(expected), true)
  assert.deepEqual(writes, [expected])
  assert.deepEqual(binding.getAuthoritativeBounds(), expected,
    'managed restore does not adopt a new baseline before lifecycle confirmation')
  toolbar.emit('resize')
  assert.equal(writes.length, 1, 'autonomous correction remains paused during managed settlement')
})

test('SEM-F22/SEM-T04/J17: failed fixed-viewport correction emits only its registered degradation', () => {
  const toolbar = new EventEmitter()
  toolbar.isDestroyed = () => false
  toolbar.getBounds = () => ({ x: 10, y: 20, width: 601, height: 74 })
  const faults = []
  bindToolbarDockInvariant({
    toolbar,
    getDockBounds: (authoritativeBounds) => authoritativeBounds,
    setDockBounds: () => { throw new Error('private-path') },
    onFault: (fault) => faults.push(fault)
  })
  toolbar.emit('resize')
  assert.deepEqual(faults, [{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }])
  assert.doesNotMatch(JSON.stringify(faults), /private-path|[A-Z]:\\/)
})
