'use strict'

const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const c = require('../contracts/agent-run-ui')

function header () {
  return { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
}

function failure (category = 'unavailable', nextAction = 'retry') {
  return {
    ...header(),
    ok: false,
    error: {
      category,
      code: category === 'invalid' ? c.ERROR_CODES.invalid : c.ERROR_CODES.unavailable,
      next_action: nextAction
    },
    result: null
  }
}

function success (result) {
  return c.assertRecordSignalResponse({ ...header(), ok: true, error: null, result })
}

function publicInteraction (detail) {
  return detail?.interaction || null
}

function terminal (item) {
  return item?.terminalReason === 'succeeded' || item?.terminalReason === 'failed' || item?.terminalReason === 'cancelled'
}

class AgentInteractionSignalService {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.getAgentInteraction !== 'function') {
      throw new TypeError('storage interaction adapter is required')
    }
    if (!options.personalContext || typeof options.personalContext.recordInteractionSignal !== 'function') {
      throw new TypeError('personal-context signal adapter is required')
    }
    this.storage = options.storage
    this.personalContext = options.personalContext
    this.promptStore = options.promptStore && typeof options.promptStore.get === 'function'
      ? options.promptStore
      : null
  }

  async recordSignal (request) {
    try {
      c.assertRecordSignalRequest(request)
    } catch {
      return failure('invalid', 'correct_input')
    }
    try {
      const detail = await this.storage.getAgentInteraction({ interactionId: request.interaction_id })
      const item = publicInteraction(detail)
      if (!item || item.recipeId === 'intent.route' || !terminal(item) || item.requestedBy !== 'user') {
        return failure('invalid', 'wait_for_terminal')
      }
      if (request.signal_kind !== 'prompt') {
        if (item.terminalReason !== 'succeeded') return failure('invalid', 'result_unavailable')
        if (request.result_digest !== item.resultDigest) return failure('invalid', 'refresh_result')
      }
      const payloadDigest = request.signal_kind === 'edit'
        ? sha256Canonical({ text: request.payload.text })
        : null
      const transient = {
        prompt: null,
        editText: request.signal_kind === 'edit' ? request.payload.text : null,
        result: item.result
      }
      const accepted = await this.personalContext.recordInteractionSignal({
        interactionId: item.interactionId,
        signalKind: request.signal_kind,
        payloadDigest,
        signalIdempotencyKey: request.signal_idempotency_key,
        transient
      })
      return success({
        accepted: accepted?.accepted === true,
        interaction_id: item.interactionId,
        replayed: accepted?.replayed === true,
        signal_kind: request.signal_kind
      })
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID' || error?.code === 'AGENT_INTERACTION_NOT_TERMINAL' ||
          error?.code === 'AGENT_INPUT_CHANGED') return failure('invalid', 'refresh_result')
      if (error?.code === 'AGENT_INTERACTION_NOT_FOUND' || error?.code === 'AGENT_SESSION_NOT_FOUND') {
        return failure('unavailable', 'retry')
      }
      return failure('unavailable', 'retry')
    }
  }

  async recordPromptSignal ({ interactionId, prompt }) {
    if (typeof interactionId !== 'string') return false
    let runId = null
    let accepted = false
    try {
      const detail = await this.storage.getAgentInteraction({ interactionId })
      const item = publicInteraction(detail)
      if (!item || item.requestedBy !== 'user' || item.recipeId === 'intent.route' || !terminal(item)) return false
      runId = item.runId || item.run_id || detail?.runId || null
      const storedPrompt = typeof prompt === 'string' ? prompt : (runId && this.promptStore ? this.promptStore.get(runId) : null)
      if (typeof storedPrompt !== 'string' || storedPrompt.length === 0) return false
      // The prompt remains in the bounded main-process map only until this
      // verification completes.  It is sent only as a bounded ephemeral
      // projection for extraction and is never persisted in the signal summary.
      if (typeof item.promptDigest !== 'string' || sha256Canonical(storedPrompt) !== item.promptDigest) return false
      const result = await this.personalContext.recordInteractionSignal({
        interactionId: item.interactionId,
        signalKind: 'prompt',
        payloadDigest: null,
        signalIdempotencyKey: `signal.prompt.${sha256Canonical(item.interactionId).slice(0, 48)}`,
        transient: { prompt: storedPrompt, editText: null, result: item.terminalReason === 'succeeded' ? item.result : null },
        awaitCompletion: true
      })
      accepted = result?.accepted === true
      return accepted && (result?.completed === undefined || result.completed === true)
    } catch {
      return false
    } finally {
      // Keep the raw prompt until the context runner settles the extraction;
      // the runtime holds only a bounded ephemeral projection while retries
      // remain possible.  Disabled or terminally settled work is cleaned up.
      if (runId && this.promptStore) this.promptStore.delete(runId)
    }
  }
}

module.exports = { AgentInteractionSignalService }
