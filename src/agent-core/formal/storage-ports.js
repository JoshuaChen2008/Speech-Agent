'use strict'

const { AgentCoreError } = require('../errors')
const { inputReference } = require('./contracts')

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

module.exports = { ArtifactWriter, TranscriptReader }
