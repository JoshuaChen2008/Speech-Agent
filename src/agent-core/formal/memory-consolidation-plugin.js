'use strict'

const { AgentCoreError } = require('../errors')

class MemoryConsolidationPlugin {
  consolidate (candidateBatches) {
    if (!Array.isArray(candidateBatches) || candidateBatches.some((batch) => !Array.isArray(batch))) {
      throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
    const candidates = []
    for (const batch of candidateBatches) {
      candidates.push(...batch)
      if (candidates.length > 200) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
    return candidates
  }
}

module.exports = { MemoryConsolidationPlugin }
