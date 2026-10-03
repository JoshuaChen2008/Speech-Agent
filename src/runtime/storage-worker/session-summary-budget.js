'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { StorageError } = require('./protocol')
const { usesLongInputBudget } = require('../../agent/contracts/budget-axes')

function isLongInputRun (run) {
  return (run?.recipe_id === 'qa.answer' && ['3', '4', '5'].includes(run.recipe_version)) ||
    (run?.recipe_id === 'context.ingest.session' && run.recipe_version === '3')
}
function isLongBudgetPolicy (policy) { return ['summary.minutes@2', 'qa.answer@3', 'qa.answer@4', 'qa.answer@5', 'context.ingest.session@3'].includes(policy) }

function fail (code) {
  throw new StorageError(code)
}

function safeInteger (value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('AGENT_REQUEST_INVALID')
  return value
}

function remainingWallClockMs (account) {
  if (!account || Number(account.accounting_known) !== 1 || !Number.isSafeInteger(Number(account.max_wall_clock_ms))) return null
  return Math.max(0, Number(account.max_wall_clock_ms) - Number(account.settled_elapsed_ms) - Number(account.conservative_elapsed_ms))
}

function createRunBudgetAccount (database, { run, budget, now }) {
  let account = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(run.run_id)
  if (account) return account

  const binding = database.prepare('SELECT budget_json FROM agent_model_run_bindings WHERE run_id=?').get(run.run_id)
  if (!binding || Number(run.attempt_count) > 0) {
    database.prepare(`
      INSERT INTO formal_agent_run_budget_state(
        run_id,policy_version,budget_digest,max_wall_clock_ms,max_requests_per_attempt,
        settled_elapsed_ms,conservative_elapsed_ms,request_count,accounting_known,created_at,updated_at
      ) VALUES(?, 'unknown', NULL, NULL, NULL, 0, 0, 0, 0, ?, ?)
    `).run(run.run_id, now, now)
    return database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(run.run_id)
  }

  let frozenBudget
  try { frozenBudget = JSON.parse(binding.budget_json) } catch { fail('AGENT_RUN_UNAVAILABLE') }
  if (!frozenBudget || !Number.isSafeInteger(frozenBudget.maxWallClockMs) || frozenBudget.maxWallClockMs < 1 ||
      !Number.isSafeInteger(frozenBudget.maxTurns) || frozenBudget.maxTurns < 1) fail('AGENT_RUN_UNAVAILABLE')
  const budgetDigest = sha256Canonical(frozenBudget)
  const policyVersion = `${run.recipe_id}@${run.recipe_version}`
  const longBudget = usesLongInputBudget(run.recipe_id, run.recipe_version)
  database.prepare(`
    INSERT INTO formal_agent_run_budget_state(
      run_id,policy_version,budget_digest,max_wall_clock_ms,max_requests_per_attempt,
      settled_elapsed_ms,conservative_elapsed_ms,request_count,accounting_known,created_at,updated_at
    ) VALUES(?,?,?,?,?,0,0,0,1,?,?)
  `).run(run.run_id, policyVersion, budgetDigest,
    longBudget ? 120 * 60 * 1000 : frozenBudget.maxWallClockMs,
    longBudget ? 512 : frozenBudget.maxTurns, now, now)
  account = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(run.run_id)
  if (!account || (budget && canonicalize(frozenBudget) !== canonicalize(budget))) fail('AGENT_RUN_UNAVAILABLE')
  return account
}

function startAttemptBudget (database, { runId, attempt, owner, leaseMs, account, now }) {
  const runRemaining = remainingWallClockMs(account)
  if (runRemaining === null) fail('AGENT_RUN_UNAVAILABLE')
  const remaining = isLongBudgetPolicy(account.policy_version)
    ? Math.min(runRemaining, 60 * 60 * 1000)
    : runRemaining
  const reserved = Math.min(leaseMs, remaining)
  database.prepare(`
    INSERT INTO formal_agent_run_attempt_budgets(
      run_id,attempt,owner,state,reserved_elapsed_ms,settled_elapsed_ms,conservative_elapsed_ms,
      request_count,request_limit,created_at,updated_at
    ) VALUES(?,?,?,'active',?,0,0,0,?,?,?)
  `).run(runId, attempt, owner, reserved, Number(account.max_requests_per_attempt), now, now)
  return { remainingWallClockMs: remaining, reservedElapsedMs: reserved }
}

function settleActiveAttempt (database, { attemptIdentity, elapsedMs, now, nextLeaseMs = null, interrupted = false }) {
  const elapsed = safeInteger(elapsedMs)
  const attempt = database.prepare(`
    SELECT * FROM formal_agent_run_attempt_budgets WHERE run_id=? AND attempt=?
  `).get(attemptIdentity.runId, attemptIdentity.attempt)
  if (!attempt || attempt.state !== 'active' || attempt.owner !== attemptIdentity.owner) fail('AGENT_CONTEXT_OPERATION_FAILED')
  const account = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(attemptIdentity.runId)
  if (!account || Number(account.accounting_known) !== 1) fail('AGENT_RUN_UNAVAILABLE')
  const settledElapsed = Number(attempt.settled_elapsed_ms) + elapsed
  const conservativeElapsed = Number(attempt.conservative_elapsed_ms) + (interrupted ? Number(attempt.reserved_elapsed_ms) : 0)
  const accountSettled = Number(account.settled_elapsed_ms) + elapsed
  const accountConservative = Number(account.conservative_elapsed_ms) + (interrupted ? Number(attempt.reserved_elapsed_ms) : 0)
  const remaining = Math.max(0, Number(account.max_wall_clock_ms) - accountSettled - accountConservative)
  const attemptRemaining = isLongBudgetPolicy(account.policy_version)
    ? Math.max(0, 60 * 60 * 1000 - settledElapsed - conservativeElapsed)
    : remaining
  const enforceableRemaining = Math.min(remaining, attemptRemaining)
  const nextReserved = nextLeaseMs === null ? 0 : Math.min(safeInteger(nextLeaseMs, 1), enforceableRemaining)
  const nextState = interrupted ? 'interrupted' : nextLeaseMs === null ? 'settled' : 'active'
  database.prepare(`
    UPDATE formal_agent_run_attempt_budgets
    SET state=?,reserved_elapsed_ms=?,settled_elapsed_ms=?,conservative_elapsed_ms=?,updated_at=?
    WHERE run_id=? AND attempt=? AND owner=? AND state='active'
  `).run(nextState, nextReserved, settledElapsed, conservativeElapsed, now,
    attemptIdentity.runId, attemptIdentity.attempt, attemptIdentity.owner)
  database.prepare(`
    UPDATE formal_agent_run_budget_state
    SET settled_elapsed_ms=?,conservative_elapsed_ms=?,updated_at=? WHERE run_id=?
  `).run(accountSettled, accountConservative, now, attemptIdentity.runId)
  const updated = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(attemptIdentity.runId)
  const runRemaining = remainingWallClockMs(updated)
  return {
    remainingWallClockMs: Math.min(runRemaining, attemptRemaining),
    settledElapsedMs: accountSettled,
    conservativeElapsedMs: accountConservative,
    requestCount: Number(updated.request_count),
    exhausted: Math.min(runRemaining, attemptRemaining) === 0
  }
}

function interruptActiveAttempt (database, runId, now) {
  const attempt = database.prepare(`
    SELECT * FROM formal_agent_run_attempt_budgets WHERE run_id=? AND state='active'
    ORDER BY attempt DESC LIMIT 1
  `).get(runId)
  if (!attempt) return null
  return settleActiveAttempt(database, {
    attemptIdentity: { runId, attempt: Number(attempt.attempt), owner: attempt.owner },
    elapsedMs: 0,
    now,
    interrupted: true
  })
}

function reserveModelRequest (database, { attemptIdentity, requestSequence, operationDigest = null, now }) {
  safeInteger(requestSequence, 1)
  const attempt = database.prepare(`
    SELECT * FROM formal_agent_run_attempt_budgets WHERE run_id=? AND attempt=?
  `).get(attemptIdentity.runId, attemptIdentity.attempt)
  if (!attempt || attempt.state !== 'active' || attempt.owner !== attemptIdentity.owner) fail('AGENT_CONTEXT_OPERATION_FAILED')
  const existing = database.prepare(`
    SELECT reservation_id,owner FROM formal_agent_model_request_reservations
    WHERE run_id=? AND attempt=? AND request_sequence=?
  `).get(attemptIdentity.runId, attemptIdentity.attempt, requestSequence)
  if (existing) {
    if (existing.owner !== attemptIdentity.owner) fail('AGENT_CONTEXT_OPERATION_FAILED')
    return { reservationId: existing.reservation_id, reserved: true, replayed: true }
  }
  if (Number(attempt.request_count) + 1 !== requestSequence) fail('AGENT_CONTEXT_OPERATION_FAILED')
  if (requestSequence > Number(attempt.request_limit)) fail('AGENT_BUDGET_EXCEEDED')
  if (operationDigest !== null) {
    const used = database.prepare(`SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations
      WHERE run_id=? AND operation_digest=?`).get(attemptIdentity.runId, operationDigest)
    if (Number(used.count) >= 5) fail('AGENT_BUDGET_EXCEEDED')
  }
  const reservationId = sha256Canonical({ runId: attemptIdentity.runId, attempt: attemptIdentity.attempt, requestSequence })
  database.prepare(`
    INSERT INTO formal_agent_model_request_reservations(
      reservation_id,run_id,attempt,request_sequence,owner,response_received_at,created_at,operation_digest
    ) VALUES(?,?,?,?,?,NULL,?,?)
  `).run(reservationId, attemptIdentity.runId, attemptIdentity.attempt, requestSequence, attemptIdentity.owner, now, operationDigest)
  database.prepare(`
    UPDATE formal_agent_run_attempt_budgets SET request_count=request_count+1,updated_at=?
    WHERE run_id=? AND attempt=? AND owner=? AND state='active'
  `).run(now, attemptIdentity.runId, attemptIdentity.attempt, attemptIdentity.owner)
  database.prepare(`
    UPDATE formal_agent_run_budget_state SET request_count=request_count+1,updated_at=? WHERE run_id=?
  `).run(now, attemptIdentity.runId)
  return { reservationId, reserved: true, replayed: false }
}

function markRequestResponse (database, { attemptIdentity, requestSequence, now }) {
  safeInteger(requestSequence, 1)
  const updated = database.prepare(`
    UPDATE formal_agent_model_request_reservations SET response_received_at=COALESCE(response_received_at,?)
    WHERE run_id=? AND attempt=? AND request_sequence=? AND owner=?
  `).run(now, attemptIdentity.runId, attemptIdentity.attempt, requestSequence, attemptIdentity.owner)
  if (Number(updated.changes) !== 1) fail('AGENT_CONTEXT_OPERATION_FAILED')
}

module.exports = {
  isLongInputRun,
  isLongBudgetPolicy,
  createRunBudgetAccount,
  interruptActiveAttempt,
  markRequestResponse,
  remainingWallClockMs,
  reserveModelRequest,
  settleActiveAttempt,
  startAttemptBudget
}
