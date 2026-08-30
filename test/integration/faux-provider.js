'use strict'

function requireCredential (credential) {
  if (!Buffer.isBuffer(credential) || credential.every((byte) => byte === 0)) throw new Error('missing borrowed credential')
}

function scenarioError (scenario) {
  if (scenario === 'redirect') { const error = new Error(); error.code = 'REDIRECT_REJECTED'; return error }
  if (scenario === 'auth') { const error = new Error(); error.code = 'AUTH_REJECTED'; return error }
  if (scenario === 'timeout') { const error = new Error(); error.code = 'TIMEOUT'; return error }
  if (scenario === 'rate-limit') { const error = new Error(); error.status = 429; return error }
  if (scenario === 'server') { const error = new Error(); error.status = 500; return error }
  if (scenario === 'unavailable' || scenario === 'network') return new Error('network')
  return null
}

function fauxProvider (scenario = 'models') {
  let releaseBarrier
  let enterBarrier
  const barrier = new Promise((resolve) => { releaseBarrier = resolve })
  const entered = new Promise((resolve) => { enterBarrier = resolve })
  const waitAtBarrier = async () => {
    if (scenario !== 'barrier') return
    enterBarrier()
    await barrier
  }
  return Object.freeze({
    entered,
    release: () => releaseBarrier(),
    async listModels ({ credential }) {
      requireCredential(credential)
      await waitAtBarrier()
      const error = scenarioError(scenario)
      if (error) throw error
      return [{ modelId: 'deepseek-v4-flash', capabilitySuggestion: null }, { modelId: 'future-model', capabilitySuggestion: null }]
    },
    async complete ({ credential }) {
      requireCredential(credential)
      await waitAtBarrier()
      const error = scenarioError(scenario)
      if (error) throw error
      if (scenario === 'usage-cache-hit') return { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 250, prompt_cache_miss_tokens: 750 } }
      if (scenario === 'usage-no-cache') return { usage: { prompt_tokens: 1000, completion_tokens: 200 } }
      if (scenario === 'usage-inconsistent-cache') return { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 250, prompt_cache_miss_tokens: 700 } }
      if (scenario === 'usage-absent') return { usage: null }
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } }
    }
  })
}

module.exports = { fauxProvider }
