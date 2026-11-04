'use strict'

const RETRY_POLICY_VERSIONS = Object.freeze(['agent-retry@1', 'agent-retry@2'])
const MAX_OPERATION_ATTEMPTS = 5

function retryPolicy (version) {
  if (version === undefined || version === null) return 'agent-retry@1'
  if (!RETRY_POLICY_VERSIONS.includes(version)) {
    throw Object.assign(new Error('AGENT_REQUEST_INVALID'), { code: 'AGENT_REQUEST_INVALID' })
  }
  return version
}

function retryDelay (version, attempt, retryAfterMs, random = Math.random) {
  const policy = retryPolicy(version)
  if (policy === 'agent-retry@2' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs
  const base = Math.min(1000, 100 * (2 ** (attempt - 1)))
  return policy === 'agent-retry@1' ? base : Math.floor(base * (0.5 + 0.5 * random()))
}

function parseRetryAfter (value, now = Date.now()) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(text) ? Math.ceil(Number(text) * 1000)
    : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(text)
      ? Math.max(0, Date.parse(text) - now) : NaN
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null
}

module.exports = { RETRY_POLICY_VERSIONS, MAX_OPERATION_ATTEMPTS, retryPolicy, retryDelay, parseRetryAfter }
