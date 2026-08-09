'use strict'

const { AgentCoreError } = require('../errors')
const { inputReference, memoryProjection, memoryQuery } = require('./contracts')

class TranscriptReader {
  constructor (storage) {
    if (!storage || typeof storage.readAgentInputSnapshot !== 'function') {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.storage = storage
  }

  readSnapshot (inputRef) {
    return this.storage.readAgentInputSnapshot({ inputRef: inputReference(inputRef) })
  }
}

class MemoryReader {
  constructor (storage) {
    if (!storage || typeof storage.readAgentMemoryContext !== 'function') {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.storage = storage
  }

  async query (query) {
    const request = memoryQuery(query)
    return memoryProjection(await this.storage.readAgentMemoryContext(request), request)
  }
}

class ArtifactWriter {
  constructor (storage) {
    if (!storage || typeof storage.commitAgentArtifact !== 'function') {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.storage = storage
  }

  commit (runId, lease, artifact) {
    return this.storage.commitAgentArtifact({ runId, lease, artifact })
  }
}

class MemoryCandidateSink {
  constructor (storage) {
    if (!storage || typeof storage.commitAgentMemoryCandidates !== 'function') {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.storage = storage
  }

  commit (runId, lease, candidates) {
    return this.storage.commitAgentMemoryCandidates({ runId, lease, candidates })
  }
}

module.exports = { ArtifactWriter, MemoryCandidateSink, MemoryReader, TranscriptReader }
