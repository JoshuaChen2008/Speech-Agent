'use strict'

function fauxProvider (scenario = 'models') {
  return Object.freeze({
    async listModels ({ credential }) {
      if (!Buffer.isBuffer(credential) || credential.every((byte) => byte === 0)) throw new Error('missing borrowed credential')
      if (scenario === 'redirect') { const error = new Error(); error.code = 'REDIRECT_REJECTED'; throw error }
      if (scenario === 'auth') { const error = new Error(); error.code = 'AUTH_REJECTED'; throw error }
      if (scenario === 'unavailable') throw new Error('network')
      return [{ modelId: 'deepseek-v4-flash', capabilitySuggestion: null }, { modelId: 'future-model', capabilitySuggestion: null }]
    }
  })
}

module.exports = { fauxProvider }
