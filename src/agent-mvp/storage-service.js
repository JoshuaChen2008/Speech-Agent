'use strict'

const { AgentMvpStore } = require('../agent-core/storage/agent-store')
const { AgentCoreError } = require('../agent-core/errors')
const { exact, failure, requestEnvelope, response } = require('./protocol')

const OPERATIONS = Object.freeze({
  INITIALIZE: 'storage:initialize', CREATE_FIXTURE: 'fixture:create', LIST_SESSIONS: 'sessions:list', READ_INPUT: 'input:read',
  CREATE_JOB: 'job:create', RECONCILE: 'jobs:reconcile', LIST_JOBS: 'jobs:list', CLAIM: 'job:claim', RETRY: 'job:retry',
  FAIL: 'job:fail', CANCEL_REQUEST: 'job:cancel-request', CANCEL_COMMIT: 'job:cancel-commit', COMMIT: 'artifact:commit',
  GET_ARTIFACT: 'artifact:get', LIST_ARTIFACTS: 'artifacts:list', CREATE_THREAD: 'thread:create', GET_OR_CREATE_THREAD: 'thread:get-or-create', APPEND_MESSAGE: 'message:append', LIST_MESSAGES: 'messages:list', SHUTDOWN: 'storage:shutdown'
})

class AgentStorageService {
  constructor () { this.store = null; this.shuttingDown = false }
  requireStore () { if (!this.store) throw new AgentCoreError('AGENT_INTERNAL_FAILURE'); return this.store }

  execute (operation, payload) {
    if (this.shuttingDown) throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    if (operation === OPERATIONS.INITIALIZE) {
      exact(payload, ['databasePath']); if (this.store || typeof payload.databasePath !== 'string') throw new AgentCoreError('AGENT_REQUEST_INVALID')
      this.store = new AgentMvpStore({ databasePath: payload.databasePath }); return { initialized: true }
    }
    if (operation === OPERATIONS.CREATE_FIXTURE) {
      exact(payload, ['sourceId'])
      if (!['loopback', 'mic'].includes(payload.sourceId)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
      return this.requireStore().createFixtureSession({ sourceId: payload.sourceId, captions: ['这是隔离 Agent 内核的合成终态会话。', '本会话不包含现场音频，只用于验证固定工具与结构化产物。'] })
    }
    if (operation === OPERATIONS.LIST_SESSIONS) { exact(payload, []); return this.requireStore().listTerminalSessions() }
    if (operation === OPERATIONS.READ_INPUT) { exact(payload, ['sessionId', 'transcriptVersion']); return this.requireStore().readInput(payload) }
    if (operation === OPERATIONS.CREATE_JOB) { exact(payload, ['inputRef', 'provider', 'model', 'clientIdempotencyKey']); return this.requireStore().createUserJob(payload) }
    if (operation === OPERATIONS.RECONCILE) { exact(payload, ['provider', 'model']); return this.requireStore().reconcileAutomaticJobs(payload) }
    if (operation === OPERATIONS.LIST_JOBS) { exact(payload, []); return this.requireStore().listJobs() }
    if (operation === OPERATIONS.CLAIM) { exact(payload, ['owner', 'leaseMs']); return this.requireStore().claimNext(payload.owner, payload.leaseMs) }
    if (operation === OPERATIONS.RETRY) { exact(payload, ['runId', 'lease', 'errorCode', 'delayMs']); return this.requireStore().markRetry(payload.runId, payload.lease, payload.errorCode, payload.delayMs) }
    if (operation === OPERATIONS.FAIL) { exact(payload, ['runId', 'lease', 'errorCode']); return this.requireStore().markFailed(payload.runId, payload.lease, payload.errorCode) }
    if (operation === OPERATIONS.CANCEL_REQUEST) { exact(payload, ['runId']); return this.requireStore().requestCancel(payload.runId) }
    if (operation === OPERATIONS.CANCEL_COMMIT) { exact(payload, ['runId', 'lease']); return this.requireStore().markCancelled(payload.runId, payload.lease) }
    if (operation === OPERATIONS.COMMIT) { exact(payload, ['runId', 'lease', 'content']); return this.requireStore().commitArtifact(payload.runId, payload.lease, payload.content) }
    if (operation === OPERATIONS.GET_ARTIFACT) { exact(payload, ['runId']); return this.requireStore().getArtifact(payload.runId) }
    if (operation === OPERATIONS.LIST_ARTIFACTS) { exact(payload, []); return this.requireStore().listArtifacts() }
    if (operation === OPERATIONS.CREATE_THREAD) { exact(payload, ['inputRef']); return this.requireStore().createDebugThread(payload.inputRef) }
    if (operation === OPERATIONS.GET_OR_CREATE_THREAD) { exact(payload, ['inputRef']); return this.requireStore().getOrCreateDebugThread(payload.inputRef) }
    if (operation === OPERATIONS.APPEND_MESSAGE) { exact(payload, ['threadId', 'role', 'content', 'provider', 'model']); return this.requireStore().appendDebugMessage(payload) }
    if (operation === OPERATIONS.LIST_MESSAGES) { exact(payload, ['threadId']); return this.requireStore().listDebugMessages(payload.threadId) }
    if (operation === OPERATIONS.SHUTDOWN) { exact(payload, []); this.store?.close(); this.store = null; this.shuttingDown = true; return { stopped: true } }
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }

  handle (message) {
    let requestId = ''
    try { const request = requestEnvelope(message); requestId = request.requestId; return response(requestId, this.execute(request.operation, request.payload)) } catch (error) { return failure(requestId, error) }
  }
}

module.exports = { AgentStorageService, OPERATIONS }
