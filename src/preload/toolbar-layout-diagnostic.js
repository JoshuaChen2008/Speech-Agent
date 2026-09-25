'use strict'

// Diagnostic-only, bounded observations. Raw clock readings and layout
// generations stay in memory; snapshot projects them before crossing the bridge.
const LIMIT = 128
const RENDERER_STAGES = Object.freeze([
  'renderer-init', 'context-requested', 'context-valid', 'context-invalid',
  'context-failed', 'bridge-missing', 'queue-pending', 'queue-no-generation',
  'queued', 'raf-ran', 'deduplicated', 'retry-scheduled', 'retry-fired',
  'send-attempted', 'sent', 'send-failed', 'unload'
])
const MAIN_STAGES = Object.freeze([
  'context-arrived', 'context-issued', 'context-rejected', 'invalidated',
  'report-arrived', 'sender-accepted', 'sender-rejected', 'handler-failed',
  'layout-accepted', 'layout-rejected'
])
const DECISIONS = Object.freeze([
  'none', 'accepted', 'report-shape', 'generation-invalid', 'generation-mismatch',
  'rect-shape', 'rect-nonfinite', 'rect-range', 'projection-empty'
])

function createRecorder (stages, now = Date.now) {
  const createdAt = now()
  const allowed = new Set(stages)
  const entries = []
  let overflowCount = 0
  let firstOverflowAt = null
  let frozen = false
  return {
    record (stage, generation = null, decision = 'none', matchesCurrent = null) {
      if (frozen || !allowed.has(stage) || !DECISIONS.includes(decision)) return
      if (entries.length === LIMIT) {
        if (firstOverflowAt === null) firstOverflowAt = now()
        overflowCount += 1
        return
      }
      entries.push({
        stage,
        generation: Number.isSafeInteger(generation) && generation > 0 ? generation : null,
        decision,
        matchesCurrent: typeof matchesCurrent === 'boolean' ? matchesCurrent : null,
        at: now()
      })
    },
    snapshot (cutoff, targetGeneration, notBefore = 0) {
      frozen = true
      // A reload that never replaced its document must not borrow that
      // document's initial-load sends as evidence for the new reload window.
      if (createdAt < notBefore) return null
      return {
        // The read-time count may include post-verdict activity. Only overflow
        // at/before cutoff makes the retained pre-verdict counts lower bounds.
        readTimeOverflowCount: overflowCount,
        overflowBeforeCutoff: firstOverflowAt !== null && firstOverflowAt <= cutoff,
        entries: entries.filter((entry) => entry.at <= cutoff).map((entry) => ({
          stage: entry.stage,
          decision: entry.decision,
          matchesCurrent: entry.matchesCurrent,
          generationRelation: entry.generation === null || !Number.isSafeInteger(targetGeneration)
            ? 'unknown'
            : entry.generation === targetGeneration ? 'target'
              : entry.generation < targetGeneration ? 'older' : 'newer'
        }))
      }
    }
  }
}

module.exports = { LIMIT, RENDERER_STAGES, MAIN_STAGES, DECISIONS, createRecorder }
