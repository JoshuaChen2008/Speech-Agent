'use strict'

const { AgentCoreError } = require('../agent-core/errors')

const VERSION = 1

function exact (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  return value
}

function requestEnvelope (value) {
  exact(value, ['version', 'type', 'requestId', 'operation', 'payload'])
  if (value.version !== VERSION || value.type !== 'agent-mvp:request' ||
      typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 128 ||
      typeof value.operation !== 'string' || value.operation.length < 1 || value.operation.length > 80) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  exact(value.payload, Object.keys(value.payload))
  return value
}

function publicError (error) {
  const allowed = new Set([
    'AGENT_REQUEST_INVALID', 'AGENT_PROVIDER_INVALID', 'AGENT_PROVIDER_AUTH_FAILED',
    'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT',
    'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_WORKER_EXITED',
    'AGENT_JOB_NOT_FOUND', 'AGENT_JOB_STATE_CONFLICT', 'AGENT_INPUT_CHANGED',
    'AGENT_SESSION_NOT_FOUND', 'AGENT_SESSION_NOT_TERMINAL', 'AGENT_CANCELLED'
  ])
  const code = allowed.has(error?.code) ? error.code : 'AGENT_INTERNAL_FAILURE'
  return { code }
}

function response (requestId, result) { return { version: VERSION, type: 'agent-mvp:response', requestId, ok: true, result } }
function failure (requestId, error) { return { version: VERSION, type: 'agent-mvp:response', requestId, ok: false, error: publicError(error) } }

module.exports = { VERSION, exact, failure, publicError, requestEnvelope, response }
