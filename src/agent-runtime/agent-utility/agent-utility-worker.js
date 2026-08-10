'use strict'

const { AgentUtilityService } = require('./service')
const { attachAgentUtilityWorker } = require('./worker-entry')

attachAgentUtilityWorker({ service: new AgentUtilityService() })
