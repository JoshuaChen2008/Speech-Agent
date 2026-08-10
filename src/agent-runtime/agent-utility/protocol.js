'use strict'

const { AgentCoreError } = require('../../agent-core/errors')
const {
  claimedJob,
  enhancedTranscriptArtifact,
  exactObject,
  memoryCandidate,
  meetingMinutesArtifact,
  sameInputReference,
  transcriptSnapshot
} = require('../../agent-core/formal/contracts')
const {
  PROVIDER_CONFIG_KEYS,
  validateAgentProviderConfigCatalog
} = require('../../agent-provider/provider-bootstrap')

const PROTOCOL_VERSION = 1
const OPERATIONS = Object.freeze({
  INITIALIZE: 'initialize',
  EXECUTE_JOB: 'executeJob',
  CANCEL: 'cancel',
  SHUTDOWN: 'shutdown'
})
const OPERATION_VALUES = Object.freeze(Object.values(OPERATIONS))
const TASK_KINDS = Object.freeze([
  'meeting-minutes',
  'memory-extraction',
  'enhanced-transcript'
])
const PUBLIC_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_OUTPUT_INVALID',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID',
  'AGENT_WORKER_EXITED',
  'AGENT_INPUT_CHANGED',
  'AGENT_CANCELLED',
  'AGENT_INTERNAL_FAILURE'
])
const RETRYABLE_CODES = new Set([
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_WORKER_EXITED'
])

function invalidRequest () {
  return new AgentCoreError('AGENT_REQUEST_INVALID')
}

function boundedRequestId (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) throw invalidRequest()
  return value
}

function requestEnvelope (value) {
  exactObject(value, ['version', 'type', 'requestId', 'operation', 'payload'])
  if (value.version !== PROTOCOL_VERSION || value.type !== 'agent-utility:request' ||
      !OPERATION_VALUES.includes(value.operation)) throw invalidRequest()
  boundedRequestId(value.requestId)
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw invalidRequest()
  }
  return value
}

function publicError (error) {
  const code = PUBLIC_ERROR_CODES.includes(error?.code) ? error.code : 'AGENT_INTERNAL_FAILURE'
  return Object.freeze({ code })
}

function successResponse (requestId, result) {
  return {
    version: PROTOCOL_VERSION,
    type: 'agent-utility:response',
    requestId: boundedRequestId(requestId),
    ok: true,
    result
  }
}

function failureResponse (requestId, error) {
  return {
    version: PROTOCOL_VERSION,
    type: 'agent-utility:response',
    requestId: boundedRequestId(requestId),
    ok: false,
    error: publicError(error)
  }
}

function responseEnvelope (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== PROTOCOL_VERSION || value.type !== 'agent-utility:response' ||
      typeof value.ok !== 'boolean') throw invalidRequest()
  boundedRequestId(value.requestId)
  if (value.ok) {
    exactObject(value, ['version', 'type', 'requestId', 'ok', 'result'])
    return { ok: true, requestId: value.requestId, result: value.result }
  }
  exactObject(value, ['version', 'type', 'requestId', 'ok', 'error'])
  exactObject(value.error, ['code'])
  if (!PUBLIC_ERROR_CODES.includes(value.error.code)) throw invalidRequest()
  return {
    ok: false,
    requestId: value.requestId,
    error: new AgentCoreError(value.error.code, { retryable: RETRYABLE_CODES.has(value.error.code) })
  }
}

function initializePayload (value) {
  exactObject(value, [])
  return {}
}

function initializeResult (value) {
  exactObject(value, ['availableTaskKinds'])
  if (!Array.isArray(value.availableTaskKinds) ||
      JSON.stringify(value.availableTaskKinds) !== JSON.stringify(TASK_KINDS)) {
    throw invalidRequest()
  }
  return { availableTaskKinds: [...value.availableTaskKinds] }
}

function providerConfiguration (value, job) {
  exactObject(value, PROVIDER_CONFIG_KEYS)
  let provider
  try {
    provider = validateAgentProviderConfigCatalog({
      schemaVersion: 1,
      providers: [{ ...value }]
    }).providers[0]
  } catch {
    throw invalidRequest()
  }
  if (job && (provider.providerId !== job.providerId ||
      provider.providerKind !== job.providerKind || provider.model !== job.model)) {
    throw invalidRequest()
  }
  return { ...provider }
}

function credentialBuffer (value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== value.length ||
      value.length < 1 || value.length > 4096) throw invalidRequest()
  const copied = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (!copied.some((byte) => byte !== 0)) throw invalidRequest()
  return Buffer.from(copied)
}

function clearCredentialBytes (value) {
  if (value instanceof Uint8Array) value.fill(0)
}

function executeJobPayload (value) {
  exactObject(value, ['job', 'snapshot', 'providerConfig', 'credentialBytes'])
  const job = claimedJob(value.job)
  const snapshot = transcriptSnapshot(value.snapshot)
  if (!sameInputReference(job.inputRef, snapshot.inputRef)) throw new AgentCoreError('AGENT_INPUT_CHANGED')
  return {
    job,
    snapshot,
    providerConfig: providerConfiguration(value.providerConfig, job),
    credentialBytes: credentialBuffer(value.credentialBytes)
  }
}

function cancelPayload (value) {
  exactObject(value, ['runId'])
  if (typeof value.runId !== 'string' || value.runId.length < 1 || value.runId.length > 160) {
    throw invalidRequest()
  }
  return { runId: value.runId }
}

function cancelResult (value, runId) {
  exactObject(value, ['runId', 'cancelled'])
  if (value.runId !== runId || typeof value.cancelled !== 'boolean') throw invalidRequest()
  return { runId: value.runId, cancelled: value.cancelled }
}

function shutdownPayload (value) {
  exactObject(value, [])
  return {}
}

function shutdownResult (value) {
  exactObject(value, ['accepted'])
  if (value.accepted !== true) throw invalidRequest()
  return { accepted: true }
}

function pluginResultForJob (value, rawJob, rawSnapshot) {
  exactObject(value, ['kind', 'value'], 'AGENT_OUTPUT_INVALID')
  const job = claimedJob(rawJob)
  const snapshot = transcriptSnapshot(rawSnapshot)
  if (!sameInputReference(job.inputRef, snapshot.inputRef)) throw new AgentCoreError('AGENT_INPUT_CHANGED')
  const validEventOrders = new Set(snapshot.items.map((item) => item.eventOrder))
  if (job.taskKind === 'meeting-minutes') {
    if (value.kind !== 'artifact') throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    return {
      kind: 'artifact',
      value: meetingMinutesArtifact(value.value, { validEventOrders, identityEvidenceAvailable: false })
    }
  }
  if (job.taskKind === 'enhanced-transcript') {
    if (value.kind !== 'artifact') throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    return {
      kind: 'artifact',
      value: enhancedTranscriptArtifact(value.value, { validEventOrders })
    }
  }
  if (job.taskKind === 'memory-extraction') {
    if (value.kind !== 'memory-candidates' || !Array.isArray(value.value) || value.value.length > 200) {
      throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
    return {
      kind: 'memory-candidates',
      value: value.value.map((candidate) => memoryCandidate(candidate, {
        sessionId: job.sessionId,
        validEventOrders
      }))
    }
  }
  throw new AgentCoreError('AGENT_OUTPUT_INVALID')
}

module.exports = {
  OPERATIONS,
  PROTOCOL_VERSION,
  PUBLIC_ERROR_CODES,
  TASK_KINDS,
  cancelPayload,
  cancelResult,
  clearCredentialBytes,
  executeJobPayload,
  failureResponse,
  initializePayload,
  initializeResult,
  pluginResultForJob,
  providerConfiguration,
  requestEnvelope,
  responseEnvelope,
  shutdownPayload,
  shutdownResult,
  successResponse
}
