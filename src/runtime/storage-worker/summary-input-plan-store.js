'use strict'

const { StorageError, assertExactKeys } = require('./protocol')
const { canonicalize } = require('./canonical-json')
const { assertModelUsage } = require('../../agent/contracts/model-access-core')
const { CANDIDATES, STAGES } = require('../../agent/contracts/summary-quality')
const POLICY = 'summary-long-input@1'
const fields = {
  planDigest: 'plan_digest', inputDigest: 'input_digest', bindingDigest: 'binding_digest',
  leafCount: 'leaf_count', nodeCount: 'node_count', segmentCount: 'segment_count',
  rawTextBytes: 'raw_text_bytes', canonicalBytes: 'canonical_bytes'
}
function fail (code = 'AGENT_REQUEST_INVALID') { throw new StorageError(code) }

function operate (store, request) {
  const extra = request?.action === 'register' ? ['plan'] : request?.action === 'receipt' ? ['requestSequence', 'usage'] : request?.action === 'stage' ? ['summaryStage', 'nodeRole', 'nodeIndex', 'loopCount'] : []
  assertExactKeys(request, ['action', 'attemptIdentity', ...extra], 'AGENT_REQUEST_INVALID')
  if (!['read', 'register', 'receipt', 'stage'].includes(request.action)) fail()
  const identity = store.assertAttempt(request.attemptIdentity)
  const db = store.database
  db.exec('BEGIN IMMEDIATE')
  let result
  try {
    const now = store.nowValue()
    const run = db.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(identity.runId)
    store.assertActiveFormalAttempt(run, identity, now, { allowPreviouslyRenewedLease: true, allowCancelRequested: true })
    if (run.cancel_requested_at !== null && request.action !== 'receipt') fail('AGENT_CANCELLED')
    const policy = run.recipe_id === 'context.ingest.session' && run.recipe_version === '3' && run.transcript_version === 'raw'
      ? 'experience-input@1' : run.recipe_id === 'qa.answer' && ['4', '5'].includes(run.recipe_version) && run.transcript_version === 'raw'
        ? 'question-retrieval@1' : run.recipe_id === 'qa.answer' && run.recipe_version === '3' && run.transcript_version === 'raw'
        ? 'qa-long-input@1' : run.summary_quality_policy || run.summary_input_policy
    if (![POLICY, 'summary-quality@1', 'qa-long-input@1', 'question-retrieval@1', 'experience-input@1'].includes(policy)) fail()
    if (request.action === 'register') {
      const plan = request.plan
      assertExactKeys(plan, [...Object.keys(fields), ...(policy === 'summary-quality@1' ? ['quality'] : [])], 'AGENT_REQUEST_INVALID')
      for (const key of ['planDigest', 'inputDigest', 'bindingDigest']) {
        if (!/^[a-f0-9]{64}$/.test(plan[key])) fail()
      }
      for (const [key, max] of Object.entries({ leafCount: 256, nodeCount: 384, segmentCount: 50000, rawTextBytes: 4194304, canonicalBytes: 8388608 })) {
        if (!Number.isSafeInteger(plan[key]) || plan[key] < 1 || plan[key] > max) fail()
      }
      if (plan.inputDigest !== run.input_digest || plan.nodeCount < plan.leafCount) fail()
      if (policy === 'summary-quality@1') {
        const q = plan.quality
        assertExactKeys(q, ['policyVersion', 'mode', 'intermediateBytes', 'finalBytes', 'requestLimit', 'stageOutputTokens', 'loopLimit', 'requestLimitCount'], 'AGENT_REQUEST_INVALID')
        if (q.policyVersion !== policy || !['whole', 'chunked'].includes(q.mode) ||
            q.mode === 'whole' && plan.leafCount !== 1 || q.mode === 'chunked' && plan.leafCount < 2 ||
            !CANDIDATES.some(([i, f]) => i === q.intermediateBytes && f === q.finalBytes) ||
            !Number.isSafeInteger(q.requestLimit) || q.requestLimit < 1 || q.requestLimit > 917504 ||
            q.loopLimit !== plan.nodeCount * 3 || q.requestLimitCount !== plan.nodeCount * 9) fail()
        assertExactKeys(q.stageOutputTokens, STAGES, 'AGENT_REQUEST_INVALID')
        for (const stage of STAGES) if (!Number.isSafeInteger(q.stageOutputTokens[stage]) || q.stageOutputTokens[stage] < 1 || q.stageOutputTokens[stage] > (stage === 'organizing_topics' ? 16384 : 65536)) fail()
        const frozen = canonicalize(q)
        const priorQuality = db.prepare('SELECT frozen_json FROM formal_agent_summary_quality WHERE run_id=?').get(identity.runId)
        if (priorQuality && priorQuality.frozen_json !== frozen) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        if (!priorQuality) db.prepare('INSERT INTO formal_agent_summary_quality(run_id,policy_version,frozen_json) VALUES(?,?,?)').run(identity.runId, policy, frozen)
      }
      const prior = db.prepare('SELECT * FROM formal_agent_run_input_plans WHERE run_id=?').get(identity.runId)
      if (prior) {
        if (prior.policy_version !== policy || Object.entries(fields).some(([key, column]) => prior[column] !== plan[key])) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      } else {
        db.prepare(`INSERT INTO formal_agent_run_input_plans
          (run_id,policy_version,${Object.values(fields).join(',')},created_at,updated_at)
          VALUES (${Array(12).fill('?').join(',')})`).run(identity.runId, policy, ...Object.keys(fields).map(key => plan[key]), now, now)
      }
    }
    const plan = db.prepare('SELECT * FROM formal_agent_run_input_plans WHERE run_id=?').get(identity.runId)
    if (!plan) fail('AGENT_RUN_UNAVAILABLE')
    if (request.action === 'stage') {
      if (policy !== 'summary-quality@1' || !STAGES.includes(request.summaryStage) || !['whole', 'leaf', 'merge'].includes(request.nodeRole) ||
          !Number.isSafeInteger(request.nodeIndex) || request.nodeIndex < 1 || request.nodeIndex > plan.node_count ||
          !Number.isSafeInteger(request.loopCount) || request.loopCount < 1 || request.loopCount > plan.node_count * 3) fail()
      const prior = db.prepare('SELECT * FROM formal_agent_summary_quality WHERE run_id=?').get(identity.runId)
      if (!prior || prior.attempt > identity.attempt || prior.attempt === identity.attempt &&
          (request.loopCount < prior.loop_count || request.nodeIndex < prior.node_index)) fail('AGENT_CONTEXT_OPERATION_FAILED')
      const q = JSON.parse(prior.frozen_json)
      if (request.summaryStage !== STAGES[(request.loopCount - 1) % 3] || request.nodeIndex !== Math.ceil(request.loopCount / 3) ||
          request.nodeRole !== (q.mode === 'whole' ? 'whole' : request.nodeIndex <= plan.leaf_count ? 'leaf' : 'merge')) fail()
      const repeated = prior.attempt === identity.attempt && request.loopCount === prior.loop_count
      if (prior.attempt === identity.attempt ? request.loopCount > prior.loop_count + 1 : request.loopCount !== 1) fail()
      if (repeated && (request.summaryStage !== prior.summary_stage || request.nodeRole !== prior.node_role)) fail()
      if (!repeated && prior.total_loop_count >= 1152) fail('AGENT_BUDGET_EXCEEDED')
      db.prepare(`UPDATE formal_agent_summary_quality SET summary_stage=?,node_role=?,attempt=?,node_index=?,loop_count=?,total_loop_count=total_loop_count+? WHERE run_id=?`)
        .run(request.summaryStage, request.nodeRole, identity.attempt, request.nodeIndex, request.loopCount, repeated ? 0 : 1, identity.runId)
    }
    if (request.action === 'receipt') {
      if (!Number.isSafeInteger(request.requestSequence) || request.requestSequence < 1) fail()
      if (request.usage !== null) {
        try { assertModelUsage(request.usage) } catch { fail() }
      }
      const row = db.prepare(`SELECT * FROM formal_agent_model_request_reservations
        WHERE run_id=? AND attempt=? AND request_sequence=? AND owner=?`).get(identity.runId, identity.attempt, request.requestSequence, identity.owner)
      if (!row) fail('AGENT_CONTEXT_OPERATION_FAILED')
      const encoded = canonicalize(request.usage)
      if (row.response_received_at !== null) {
        if (row.usage_json !== encoded) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      } else {
        db.prepare(`UPDATE formal_agent_model_request_reservations SET response_received_at=?,usage_json=?
          WHERE reservation_id=?`).run(now, encoded, row.reservation_id)
        db.prepare(`UPDATE formal_agent_run_input_plans SET usage_known=MIN(usage_known,?),
          input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=? WHERE run_id=?`)
          .run(request.usage === null ? 0 : 1, request.usage?.inputTokens || 0, request.usage?.outputTokens || 0, now, identity.runId)
      }
    }
    const current = db.prepare('SELECT * FROM formal_agent_run_input_plans WHERE run_id=?').get(identity.runId)
    const pending = db.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations WHERE run_id=? AND response_received_at IS NULL').get(identity.runId)
    result = {
      planDigest: current.plan_digest, known: current.usage_known === 1 && pending.count === 0 &&
        db.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations WHERE run_id=?').get(identity.runId).count > 0,
      inputTokens: current.input_tokens, outputTokens: current.output_tokens
    }
    if (['qa-long-input@1', 'question-retrieval@1', 'summary-quality@1'].includes(policy)) {
      const receipts = db.prepare('SELECT usage_json FROM formal_agent_model_request_reservations WHERE run_id=?').all(identity.runId)
        .map(row => row.usage_json === null ? null : JSON.parse(row.usage_json))
      const cacheKnown = result.known && receipts.every(usage => usage?.cacheHitInputTokens !== null && usage?.cacheMissInputTokens !== null)
      result.cacheHitInputTokens = cacheKnown ? receipts.reduce((sum, usage) => sum + usage.cacheHitInputTokens, 0) : null
      result.cacheMissInputTokens = cacheKnown ? receipts.reduce((sum, usage) => sum + usage.cacheMissInputTokens, 0) : null
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  if (result.inputTokens >= 16000000 || result.outputTokens >= 1000000) fail('AGENT_BUDGET_EXCEEDED')
  return result
}

module.exports = { operate, POLICY }
