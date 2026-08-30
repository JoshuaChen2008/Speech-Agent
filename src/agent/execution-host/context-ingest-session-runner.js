'use strict'

const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')

class ContextIngestSessionRunner {
  constructor (options = {}) {
    if (!options.personalContext || typeof options.personalContext.ingest !== 'function') {
      throw new TypeError('personalContext ingest seam is required')
    }
    if (!options.storage || typeof options.storage.completeFormalAgentRun !== 'function' ||
        typeof options.storage.failFormalAgentRun !== 'function') {
      throw new TypeError('formal Agent settlement adapter is required')
    }
    this.personalContext = options.personalContext
    this.storage = options.storage
  }

  async run (job) {
    if (job?.recipeId !== 'context.ingest.session' || !job.source || !job.attemptIdentity) {
      throw new TypeError('unsupported formal Agent job')
    }
    try {
      const result = await this.personalContext.ingest(job.source)
      const summary = { episodeCount: result.episodeCount, memoryCount: result.memoryCount }
      await this.storage.completeFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        resultDigest: sha256Canonical(summary),
        resultSummary: summary
      })
      return result
    } catch {
      await this.storage.failFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        errorCode: 'AGENT_INTERNAL_FAILURE'
      })
      return null
    }
  }
}

module.exports = { ContextIngestSessionRunner }
