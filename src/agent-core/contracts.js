'use strict'

const { AgentCoreError } = require('./errors')

const PROVIDER_IDS = Object.freeze(['openai-compatible', 'deterministic-test'])
const TRANSCRIPT_VERSIONS = Object.freeze(['original', 'refined'])
const JOB_STATES = Object.freeze(['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'])

function exactObject (value, keys, code = 'AGENT_REQUEST_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentCoreError(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new AgentCoreError(code)
  return value
}

function boundedString (value, min, max, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new AgentCoreError(code)
  return value
}

function inputReference (value) {
  exactObject(value, ['sessionId', 'inputWatermark', 'transcriptVersion', 'inputDigest'])
  boundedString(value.sessionId, 1, 160)
  if (!Number.isSafeInteger(value.inputWatermark) || value.inputWatermark < 1) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  if (!TRANSCRIPT_VERSIONS.includes(value.transcriptVersion) || !/^[a-f0-9]{64}$/.test(value.inputDigest)) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return Object.freeze({ ...value })
}

function providerConfiguration (value) {
  exactObject(value, ['provider', 'baseUrl', 'model'])
  if (value.provider !== 'openai-compatible') throw new AgentCoreError('AGENT_PROVIDER_INVALID')
  boundedString(value.model, 1, 160, 'AGENT_PROVIDER_INVALID')
  let url
  try { url = new URL(value.baseUrl) } catch { throw new AgentCoreError('AGENT_PROVIDER_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AgentCoreError('AGENT_PROVIDER_INVALID')
  }
  return Object.freeze({ provider: value.provider, baseUrl: url.toString().replace(/\/$/, ''), model: value.model })
}

module.exports = { JOB_STATES, PROVIDER_IDS, TRANSCRIPT_VERSIONS, boundedString, exactObject, inputReference, providerConfiguration }
