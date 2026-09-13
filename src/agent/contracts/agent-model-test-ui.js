'use strict'

const CONTRACT_ID = 'agent-model-test-ui'
const CONTRACT_VERSION = '1.0.0'
const IPC_CHANNELS = Object.freeze({ testSavedModel: 'agent-model:test-saved-model', cancelSavedModel: 'agent-model:cancel-saved-model' })
const STATUS = Object.freeze(['success', 'invalid_request', 'revision_conflict', 'credential_unavailable', 'auth_failed', 'timeout', 'rate_limited', 'redirect_rejected', 'response_invalid', 'remote_unavailable', 'cancelled'])
const NEXT_ACTION = Object.freeze(['none', 'reload', 'set_credential', 'edit_connection', 'check_model', 'retry'])
const NEXT_ACTION_BY_STATUS = Object.freeze({ success: 'none', invalid_request: 'edit_connection', revision_conflict: 'reload', credential_unavailable: 'set_credential', auth_failed: 'set_credential', timeout: 'retry', rate_limited: 'retry', redirect_rejected: 'edit_connection', response_invalid: 'check_model', remote_unavailable: 'retry', cancelled: 'none' })
const TEST_ID = /^[A-Za-z0-9._:-]{1,64}$/u

function fail (path) { throw new TypeError(`${path}: invalid model test UI contract`) }
function exact (value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(path)
}
function header (value, path) { if (value.contractId !== CONTRACT_ID || value.contractVersion !== CONTRACT_VERSION) fail(path) }
function text (value, path, max = 256) { if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || Buffer.byteLength(value, 'utf8') > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(path) }
function revision (value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(path) }
function testId (value, path) { if (typeof value !== 'string' || !TEST_ID.test(value)) fail(path) }
function assertTestRequest (value) { exact(value, ['contractId', 'contractVersion', 'profileId', 'modelId', 'expectedRevision', 'testId'], 'testSavedModelRequest'); header(value, 'testSavedModelRequest'); text(value.profileId, 'testSavedModelRequest.profileId', 128); text(value.modelId, 'testSavedModelRequest.modelId'); revision(value.expectedRevision, 'testSavedModelRequest.expectedRevision'); testId(value.testId, 'testSavedModelRequest.testId'); return value }
function assertCancelRequest (value) { exact(value, ['contractId', 'contractVersion', 'testId'], 'cancelSavedModelRequest'); header(value, 'cancelSavedModelRequest'); testId(value.testId, 'cancelSavedModelRequest.testId'); return value }
function assertTestResponse (value) {
  exact(value, ['contractId', 'contractVersion', 'testId', 'ok', 'status', 'nextAction'], 'testSavedModelResponse'); header(value, 'testSavedModelResponse'); testId(value.testId, 'testSavedModelResponse.testId')
  if (typeof value.ok !== 'boolean' || !STATUS.includes(value.status) || !NEXT_ACTION.includes(value.nextAction) || value.nextAction !== NEXT_ACTION_BY_STATUS[value.status] || value.ok !== (value.status === 'success')) fail('testSavedModelResponse')
  return value
}

module.exports = Object.freeze({ CONTRACT_ID, CONTRACT_VERSION, IPC_CHANNELS, NEXT_ACTION_BY_STATUS, NEXT_ACTION, STATUS, assertCancelRequest, assertTestRequest, assertTestResponse })
