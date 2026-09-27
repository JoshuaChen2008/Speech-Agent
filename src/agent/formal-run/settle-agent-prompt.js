'use strict'

async function settleFormalAgentPrompt ({ promptStore, signalService, runId, terminalReason, interactionId }) {
  try {
    if (terminalReason && interactionId && signalService) {
      await signalService.recordPromptSignal({ interactionId, prompt: promptStore.get(runId) })
    }
  } finally {
    promptStore.delete(runId)
  }
}

module.exports = { settleFormalAgentPrompt }
