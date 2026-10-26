'use strict'

const { AgentOperationService, REQUEST_TARGETS, SUMMARY_PROMPT, publicSnapshot, requestIdentity } = require('./agent-operation-service')

// Compatibility for existing request-service consumers. New production callers
// supply model access directly to the single operation service.
class SessionSummaryRunService extends AgentOperationService {
  constructor (options = {}) {
    super({ ...options, modelAccess: options.modelAccess || options.runService?.modelAccess,
      onRequestChanged: options.onChanged })
    this.eligibilityReader = options.runService || null
  }
  getEligibility (request) {
    return this.eligibilityReader ? this.eligibilityReader.getEligibility(request) : super.getEligibility(request)
  }
  subscribeChanged (listener) { return this.subscribeRequestChanged(listener) }
}
module.exports = { REQUEST_TARGETS, SUMMARY_PROMPT, SessionSummaryRunService, publicSnapshot, requestIdentity }
