'use strict'

const { StorageError, assertExactKeys } = require('./protocol')
const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const { validateRecipeOutput } = require('../../agent/contracts/recipes')

function fail (code = 'AGENT_REQUEST_INVALID') { throw new StorageError(code) }
function integer (value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail()
}

function coverage (db, runId, plan) {
  const row = db.prepare(`SELECT COUNT(*) AS ranges,COALESCE(SUM(experience_count),0) AS experiences
    FROM personal_context_experience_ranges WHERE run_id=?`).get(runId)
  return { schemaVersion: 3, stage: 'receipt', rangeCount: Number(plan.leaf_count),
    completedRanges: Number(row.ranges), experienceCount: Number(row.experiences), inputDigest: plan.input_digest }
}

// Authoritative source coverage is a contiguous prefix of Unicode fragments.
// Event orders are global and may have gaps; adjacency uses actual segment order.
function validateParts (parts, snapshot, previous, final) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 500 || Buffer.byteLength(canonicalize(parts)) > 65536) fail()
  const events = new Map(snapshot.events.map((event, index) => [event.eventOrder, { ...event, index, points: Array.from(event.text) }]))
  let prior = previous
  for (const part of parts) {
    assertExactKeys(part, ['eventOrder', 'segmentId', 'codePointStart', 'codePointEnd'], 'AGENT_REQUEST_INVALID')
    const event = events.get(part.eventOrder)
    if (!event || event.segmentId !== part.segmentId) fail('AGENT_INPUT_CHANGED')
    integer(part.codePointStart, 0, Math.max(0, event.points.length - 1))
    integer(part.codePointEnd, event.points.length === 0 ? 0 : part.codePointStart + 1, event.points.length)
    if (prior) {
      const priorEvent = events.get(prior.eventOrder)
      if (!priorEvent || (event.index === priorEvent.index
        ? part.codePointStart !== prior.codePointEnd
        : event.index !== priorEvent.index + 1 || prior.codePointEnd !== priorEvent.points.length || part.codePointStart !== 0)) fail()
    } else if (event.index !== 0 || part.codePointStart !== 0) fail()
    prior = part
  }
  const tail = parts.at(-1)
  if (final && (events.get(tail.eventOrder).index !== snapshot.events.length - 1 || tail.codePointEnd !== events.get(tail.eventOrder).points.length)) fail()
  return events
}

function operate (store, request) {
  const committing = request?.action === 'commit'
  assertExactKeys(request, ['action', 'attemptIdentity', ...(committing ? ['ordinal', 'planDigest', 'parts', 'output'] : [])], 'AGENT_REQUEST_INVALID')
  if (!['status', 'commit', 'memories'].includes(request.action)) fail()
  const identity = store.assertAttempt(request.attemptIdentity)
  const db = store.database
  db.exec('BEGIN IMMEDIATE')
  try {
    const run = db.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(identity.runId)
    store.assertActiveFormalAttempt(run, identity, store.nowValue(), { allowPreviouslyRenewedLease: true, allowCancelRequested: true })
    if (run.cancel_requested_at !== null) fail('AGENT_CANCELLED')
    if (run.recipe_id !== 'context.ingest.session' || run.recipe_version !== '3' || run.transcript_version !== 'raw') fail()
    if (request.action === 'memories') {
      const source = { sourceKind: 'session', sessionId: JSON.parse(run.scope_json).reference, transcriptVersion: 'raw',
        inputWatermark: JSON.parse(run.input_watermark_json).throughEventOrder, inputDigest: run.input_digest, ingestRunId: run.run_id }
      const memories = store.attachIngestMemories({}, source).confirmedMemories
      db.exec('COMMIT')
      return { confirmedMemories: memories }
    }
    const plan = db.prepare('SELECT * FROM formal_agent_run_input_plans WHERE run_id=?').get(identity.runId)
    if (!plan || plan.policy_version !== 'experience-input@1') fail('AGENT_RUN_UNAVAILABLE')
    let receipt = coverage(db, identity.runId, plan)
    if (!committing) {
      db.exec('COMMIT')
      return receipt
    }
    integer(request.ordinal, 0, Number(plan.leaf_count) - 1)
    if (request.planDigest !== plan.plan_digest) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
    try { validateRecipeOutput('context.ingest.session', '3', request.output) } catch { fail('AGENT_OUTPUT_INVALID') }
    if (request.output.stage !== 'range') fail('AGENT_OUTPUT_INVALID')
    const digest = sha256Canonical({ parts: request.parts, output: request.output })
    const existing = db.prepare('SELECT * FROM personal_context_experience_ranges WHERE run_id=? AND ordinal=?').get(identity.runId, request.ordinal)
    if (existing) {
      if (existing.product_digest !== digest || existing.plan_digest !== request.planDigest) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      db.exec('COMMIT')
      return { ...receipt, replayed: true }
    }
    if (request.ordinal !== receipt.completedRanges) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
    const episode = db.prepare("SELECT * FROM personal_context_episodes WHERE ingest_run_id=? AND source_kind='session' AND lifecycle='active'").get(identity.runId)
    if (!episode) fail('AGENT_CONTEXT_OPERATION_FAILED')
    const snapshot = store.sessionInput({ sourceKind: 'session', sessionId: episode.session_id, transcriptVersion: 'raw',
      inputWatermark: Number(episode.input_watermark), inputDigest: episode.input_digest })
    const prior = request.ordinal > 0
      ? JSON.parse(db.prepare('SELECT parts_json FROM personal_context_experience_ranges WHERE run_id=? AND ordinal=?').get(identity.runId, request.ordinal - 1).parts_json).at(-1)
      : null
    const events = validateParts(request.parts, snapshot, prior, request.ordinal === Number(plan.leaf_count) - 1)
    const allowed = new Set(request.parts.map(part => part.eventOrder))
    const validRef = ref => allowed.has(ref.fromEventOrder) && allowed.has(ref.throughEventOrder)
    const rangeId = `range.${sha256Canonical({ runId: identity.runId, planDigest: request.planDigest, ordinal: request.ordinal }).slice(0, 44)}`
    // Association equality checks see only the supplied fragment, not the rest
    // of an unusually long subtitle segment.
    const boundedSnapshot = { ...snapshot, events: request.parts.map(part => ({ ...events.get(part.eventOrder),
      text: events.get(part.eventOrder).points.slice(part.codePointStart, part.codePointEnd).join('') })) }
    store.commitSessionIngest({ runId: identity.runId, attemptIdentity: identity, output: request.output }, {
      snapshot: boundedSnapshot, validRef,
      publish: (boundEpisode, output) => {
        db.prepare(`INSERT INTO personal_context_experience_ranges
          (range_id,run_id,episode_id,ordinal,plan_digest,parts_json,product_digest,experience_count,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(rangeId, identity.runId, boundEpisode.episode_id, request.ordinal, request.planDigest,
            canonicalize(request.parts), digest, output.experiences.length, store.nowValue())
        const insert = db.prepare(`INSERT INTO personal_context_experiences
          (experience_id,range_id,ordinal,kind,text,confidence,source_ref_json,source_parts_json,occurred_from_offset_ms,occurred_through_offset_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
        output.experiences.forEach((item, ordinal) => {
          const parts = request.parts.filter(part => part.eventOrder >= item.evidence.fromEventOrder && part.eventOrder <= item.evidence.throughEventOrder)
          const first = db.prepare('SELECT t0_ms FROM caption_events WHERE session_id=? AND event_order=? AND kind=\'final\'').get(snapshot.sessionId, item.evidence.fromEventOrder)
          const last = db.prepare('SELECT t1_ms FROM caption_events WHERE session_id=? AND event_order=? AND kind=\'final\'').get(snapshot.sessionId, item.evidence.throughEventOrder)
          if (!first || !last) fail('AGENT_INPUT_CHANGED')
          insert.run(`experience.${sha256Canonical({ rangeId, ordinal }).slice(0, 40)}`, rangeId, ordinal, item.kind, item.text, item.confidence,
            canonicalize(item.evidence), canonicalize(parts), Number(first.t0_ms), Math.max(Number(first.t0_ms), Number(last.t1_ms)))
        })
      }
    })
    receipt = coverage(db, identity.runId, plan)
    db.exec('COMMIT')
    return { ...receipt, replayed: false }
  } catch (error) {
    rollbackQuietly(db)
    throw error
  }
}

module.exports = { operate }
