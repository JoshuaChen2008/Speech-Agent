'use strict'

// Existing consumers retain their versioned contract; production composes the
// operation service directly. There is no second implementation here.
const { AgentOperationService } = require('./agent-operation-service')
const { decodeCursor, encodeCursor, sessionItem } = require('./agent-interaction-reader')
module.exports = { AgentRunService: AgentOperationService, createAgentRunService: options => new AgentOperationService(options),
  decodeCursor, encodeCursor, sessionItem }
