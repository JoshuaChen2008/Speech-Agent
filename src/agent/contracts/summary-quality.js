'use strict'

// Versioned host and storage policy. These values do not rewrite old recipes.
const POLICY = 'summary-quality@1'
const STAGES = Object.freeze(['organizing_topics', 'drafting_minutes', 'verifying_sources'])
const CANDIDATES = Object.freeze([[128, 256], [64, 256], [64, 128], [32, 128], [32, 64], [16, 64], [16, 32], [8, 32], [8, 16]].map(pair => Object.freeze(pair.map(n => n * 1024))))
const MAX_BUFFER_BYTES = 128 * 1024 * 1024

function assertSummaryBuffer (bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BUFFER_BYTES) {
    throw Object.assign(new Error('AGENT_BUDGET_EXCEEDED'), { code: 'AGENT_BUDGET_EXCEEDED' })
  }
}

module.exports = { POLICY, STAGES, CANDIDATES, MAX_BUFFER_BYTES, assertSummaryBuffer }
