'use strict'

const { AgentCoreError } = require('../errors')
const {
  canonicalBytes,
  memoryExtractionOutput,
  throwIfAborted
} = require('./contracts')
const { MemoryConsolidationPlugin } = require('./memory-consolidation-plugin')

function eventOrdersForSegments (segments) {
  return new Set(segments.map((segment) => segment.eventOrder))
}

class MemoryExtractionPlugin {
  constructor ({ consolidation = new MemoryConsolidationPlugin() } = {}) {
    if (!consolidation || typeof consolidation.consolidate !== 'function') {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
    this.consolidation = consolidation
  }

  async extract ({ plan, limits, invokeModel, signal }) {
    const candidateBatches = []
    let candidateCount = 0
    for (const chunk of plan.chunks) {
      throwIfAborted(signal)
      const input = {
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        inputRef: plan.inputRef,
        segments: chunk.segments
      }
      if (canonicalBytes(input) > limits.maxChunkInputBytes) {
        throw new AgentCoreError('AGENT_REQUEST_INVALID')
      }
      const output = await invokeModel('memory-extraction.chunk', input, signal)
      throwIfAborted(signal)
      if (canonicalBytes(output, 'AGENT_OUTPUT_INVALID') > limits.maxResultBytes) {
        throw new AgentCoreError('AGENT_OUTPUT_INVALID')
      }
      const checked = memoryExtractionOutput(output, {
        sessionId: plan.inputRef.sessionId,
        validEventOrders: eventOrdersForSegments(chunk.segments)
      })
      candidateBatches.push(checked.candidates)
      candidateCount += checked.candidates.length
      if (candidateCount > 200) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
    throwIfAborted(signal)
    return this.consolidation.consolidate(candidateBatches)
  }
}

module.exports = { MemoryExtractionPlugin }
