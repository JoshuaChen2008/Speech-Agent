'use strict'

class AgentCoreError extends Error {
  constructor (code, options = {}) {
    super(code, options)
    this.name = 'AgentCoreError'
    this.code = code
    this.retryable = Boolean(options.retryable)
  }
}

function asAgentCoreError (error) {
  if (error instanceof AgentCoreError) return error
  return new AgentCoreError('AGENT_INTERNAL_FAILURE')
}

module.exports = { AgentCoreError, asAgentCoreError }
