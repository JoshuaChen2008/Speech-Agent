'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { settleFormalAgentPrompt } = require('../../src/agent/formal-run/settle-agent-prompt')

test('SEM-F38/SEM-T04/J30-STATE: prompt cleanup runs even when settled-signal persistence fails', async () => {
  const promptStore = new Map([['run.prompt.cleanup', 'private prompt']])
  const signalService = {
    async recordPromptSignal () { throw new Error('storage unavailable') }
  }
  await assert.rejects(settleFormalAgentPrompt({
    promptStore,
    signalService,
    runId: 'run.prompt.cleanup',
    terminalReason: 'failed',
    interactionId: 'interaction.prompt.cleanup'
  }), /storage unavailable/)
  assert.equal(promptStore.has('run.prompt.cleanup'), false)
})
