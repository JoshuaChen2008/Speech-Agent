'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentMvpStore } = require('../../src/agent-core/storage/agent-store')
const { openSubtitleDatabase } = require('../../src/runtime/storage-worker/sqlite-store')

function fixtureStore (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-store-'))
  let now = 1000
  const store = new AgentMvpStore({ databasePath: path.join(root, 'agent.db'), now: () => now++ })
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return store
}

test('SEM-F29 / J23 real SQLite freezes terminal input and reconciles idempotently', (t) => {
  const store = fixtureStore(t)
  const input = store.createFixtureSession({ sessionId: 'fixture-terminal', captions: ['alpha', 'beta'] })
  assert.equal(input.inputRef.inputWatermark, 2)
  assert.equal(store.listTerminalSessions().length, 1)
  const first = store.reconcileAutomaticJobs({ provider: 'deterministic-test', model: 'fixture-model' })
  const repeated = store.reconcileAutomaticJobs({ provider: 'deterministic-test', model: 'fixture-model' })
  assert.equal(first[0].status, 'created')
  assert.equal(repeated[0].status, 'already_processed')
  assert.equal(first[0].job.runId, repeated[0].job.runId)
})

test('SEM-F29 / J23 user idempotency, lease recovery, retry and artifact commit keep one run', (t) => {
  const store = fixtureStore(t)
  const input = store.createFixtureSession({ captions: ['one'] })
  const request = { inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'click-1' }
  const first = store.createUserJob(request)
  const repeated = store.createUserJob(request)
  assert.equal(first.job.runId, repeated.job.runId)
  assert.throws(() => store.createUserJob({ ...request, model: 'other' }), { code: 'AGENT_REQUEST_INVALID' })
  const firstLease = store.claimNext('runner')
  assert.equal(firstLease.runId, first.job.runId)
  const retry = store.markRetry(first.job.runId, firstLease.lease, 'AGENT_PROVIDER_TIMEOUT', 2000)
  assert.equal(retry.state, 'retry_wait')
  assert.equal(retry.runId, first.job.runId)
  store.database.prepare('UPDATE agent_jobs SET next_attempt_at=0 WHERE run_id=?').run(first.job.runId)
  const secondLease = store.claimNext('runner')
  assert.equal(secondLease.runId, first.job.runId)
  const artifact = store.commitArtifact(first.job.runId, secondLease.lease, { title: 'Reference', bullets: ['Item'] })
  assert.equal(store.getJob(first.job.runId).state, 'succeeded')
  assert.equal(artifact.type, 'reference-output')
  assert.equal(artifact.content.title, 'Reference')
  assert.equal(store.getArtifact(first.job.runId).contentDigest, artifact.contentDigest)
})

test('SEM-F29 / J23 stale lease cannot commit and exhausted expired work fails closed', (t) => {
  const store = fixtureStore(t)
  const input = store.createFixtureSession({ captions: ['lease'] })
  const created = store.createUserJob({ inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'lease-case' })
  const stale = store.claimNext('old-worker', 1000)
  store.database.prepare('UPDATE agent_jobs SET lease_expires_at=0 WHERE run_id=?').run(created.job.runId)
  const current = store.claimNext('new-worker', 1000)
  assert.throws(() => store.commitArtifact(created.job.runId, stale.lease, { title: 'stale', bullets: ['blocked'] }), { code: 'AGENT_JOB_STATE_CONFLICT' })
  assert.equal(store.commitArtifact(created.job.runId, current.lease, { title: 'current', bullets: ['accepted'] }).content.title, 'current')

  const second = store.createUserJob({ inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'exhausted-case' })
  store.database.prepare("UPDATE agent_jobs SET state='running',attempt_count=max_attempts,lease_owner='dead',lease_expires_at=0 WHERE run_id=?").run(second.job.runId)
  assert.equal(store.claimNext('replacement'), null)
  assert.equal(store.getJob(second.job.runId).state, 'failed')
  assert.equal(store.getJob(second.job.runId).errorCode, 'AGENT_WORKER_EXITED')
})

test('SEM-F29 candidate migration never changes the formal subtitle catalog', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-schema-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const database = openSubtitleDatabase(path.join(root, 'subtitle.db'))
  assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 2)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'agent_%'").get().count, 0)
  database.close()
})

test('SEM-F29 / J23 cancellation is terminal with no error code and debug messages reject raw model events', (t) => {
  const store = fixtureStore(t)
  const input = store.createFixtureSession({ captions: ['cancel'] })
  const queued = store.createUserJob({ inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'cancel-queued' })
  assert.equal(store.requestCancel(queued.job.runId).state, 'cancelled')
  assert.equal(store.claimNext('runner'), null)
  assert.equal(store.getJob(queued.job.runId).state, 'cancelled')
  assert.equal(store.getJob(queued.job.runId).errorCode, null)

  const thread = store.createDebugThread(input.inputRef)
  assert.throws(() => store.appendDebugMessage({ threadId: thread.threadId, role: 'assistant', content: { thinking: 'hidden' } }), { code: 'AGENT_REQUEST_INVALID' })
  assert.throws(() => store.appendDebugMessage({ threadId: thread.threadId, role: 'assistant', content: { delta: 'stream' } }), { code: 'AGENT_REQUEST_INVALID' })
  store.appendDebugMessage({ threadId: thread.threadId, role: 'assistant', content: { text: 'final only' }, provider: 'deterministic-test', model: 'fixture-model' })
  assert.deepEqual(store.listDebugMessages(thread.threadId)[0].content, { text: 'final only' })
})

test('SEM-F29 / J23 terminal cancellation is a no-op and invalid providers fail before SQLite', (t) => {
  const store = fixtureStore(t)
  const input = store.createFixtureSession({ captions: ['terminal'] })
  assert.throws(() => store.createUserJob({ inputRef: input.inputRef, provider: 'bad-provider', model: 'fixture-model', clientIdempotencyKey: 'bad-provider' }), { code: 'AGENT_REQUEST_INVALID' })
  assert.throws(() => store.reconcileAutomaticJobs({ provider: 'bad-provider', model: 'fixture-model' }), { code: 'AGENT_REQUEST_INVALID' })

  const created = store.createUserJob({ inputRef: input.inputRef, provider: 'deterministic-test', model: 'fixture-model', clientIdempotencyKey: 'terminal-cancel' })
  const claimed = store.claimNext('runner')
  store.commitArtifact(created.job.runId, claimed.lease, { title: 'done', bullets: ['done'] })
  const terminal = store.requestCancel(created.job.runId)
  assert.equal(terminal.state, 'succeeded')
  assert.equal(terminal.cancelRequestedAt, null)
})
