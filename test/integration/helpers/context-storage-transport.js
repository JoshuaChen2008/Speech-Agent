'use strict'

const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../../src/runtime/storage-worker/protocol')

// This is transport only: the gateway, storage service and SQLite domain
// modules are real. No product decision is reimplemented in this helper.
function transport (service, databasePath) {
  let sequence = 0
  const call = async (operation, payload, idempotencyKey) => {
    const response = await service.handle({ version: PROTOCOL_VERSION, type: 'storage:request', requestId: `experience.${++sequence}`,
      operation, payload, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!response.ok) {
      const error = new StorageError(response.error.code)
      error.message = `${operation}: ${response.error.code}`
      throw error
    }
    return response.result
  }
  const host = {
    state: 'stopped',
    async start () { await call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    openSession: value => call(OPERATIONS.OPEN_SESSION, value, makeOpenSessionKey(value.sessionId)),
    appendCaption: value => call(OPERATIONS.APPEND_CAPTION, { event: value }, makeCaptionEventId(value)),
    closeSession: value => call(OPERATIONS.CLOSE_SESSION, value, makeCloseSessionKey(value.sessionId)),
    getSessionTranscript: sessionId => call(OPERATIONS.GET_SESSION, { sessionId }),
    listSessions: input => call(OPERATIONS.LIST_SESSIONS, input),
    getSessionPage: input => call(OPERATIONS.GET_SESSION_PAGE, input),
    personalContextManage: command => call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command }),
    modelAccessCatalog: () => call(OPERATIONS.MODEL_ACCESS_CATALOG, {}),
    modelAccessConfigure: input => call(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input }),
    modelAccessBind: (request, availableSlotIds) => call(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds }),
    async shutdown () { if (!service.shuttingDown) await call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
  for (const [method, operation] of Object.entries({
    preparePersonalContextSessionIngest: 'PERSONAL_CONTEXT_PREPARE_SESSION_INGEST',
    derivePersonalContextSessionSource: 'PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE',
    readPersonalContextSessionRangePage: 'PERSONAL_CONTEXT_READ_SESSION_RANGE_PAGE',
    readPersonalContextSessionInput: 'PERSONAL_CONTEXT_READ_SESSION_INPUT',
    readPersonalContextToolContext: 'PERSONAL_CONTEXT_READ_TOOL_CONTEXT',
    commitPersonalContextSessionIngest: 'PERSONAL_CONTEXT_COMMIT_SESSION_INGEST',
    personalContextSessionExperiences: 'PERSONAL_CONTEXT_SESSION_EXPERIENCES',
    personalContextQuestionEvidence: 'PERSONAL_CONTEXT_QUESTION_EVIDENCE',
    createAgentRun: 'AGENT_CREATE_RUN',
    cancelAgentRun: 'AGENT_CANCEL_RUN',
    applyPersonalContextAutomaticPolicy: 'PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY',
    claimNextFormalAgentRun: 'FORMAL_AGENT_CLAIM_RUN', renewFormalAgentRun: 'FORMAL_AGENT_RENEW_RUN_LEASE',
    failFormalAgentRun: 'FORMAL_AGENT_FAIL_RUN', cancelPersonalContextSessionIngest: 'PERSONAL_CONTEXT_CANCEL_SESSION_INGEST',
    summaryInputPlan: 'SUMMARY_INPUT_PLAN', reserveFormalAgentModelRequest: 'FORMAL_AGENT_RESERVE_MODEL_REQUEST',
    createAgentInteraction: 'AGENT_CREATE_INTERACTION', terminalizeAgentInteraction: 'AGENT_TERMINALIZE_INTERACTION',
    getAgentInteraction: 'AGENT_GET_INTERACTION',
    listAgentInteractions: 'AGENT_LIST_INTERACTIONS',
    startAgentToolCall: 'AGENT_START_TOOL_CALL', finishAgentToolCall: 'AGENT_FINISH_TOOL_CALL'
  })) host[method] = (request = {}) => call(OPERATIONS[operation], { request })
  return host
}

module.exports = { transport }
