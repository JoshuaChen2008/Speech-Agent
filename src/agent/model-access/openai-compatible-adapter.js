'use strict'

const { joinEndpoint } = require('./connection')

const MAX_CATALOG_RESPONSE_BYTES = 256 * 1024

class OpenAiCompatibleAdapter {
  constructor (options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    if (typeof this.fetch !== 'function') throw new TypeError('fetch is required')
  }

  async listModels ({ connection, credential, signal }) {
    const response = await this.fetch(joinEndpoint(connection, '/models'), {
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: `Bearer ${credential.toString('utf8')}` },
      signal
    })
    if (response.status >= 300 && response.status < 400) {
      const error = new Error('redirect rejected'); error.code = 'REDIRECT_REJECTED'; throw error
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('credential rejected'); error.code = 'AUTH_REJECTED'; throw error
    }
    if (!response.ok) throw new Error('remote unavailable')
    const declaredBytes = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CATALOG_RESPONSE_BYTES) throw new Error('remote unavailable')
    let body
    if (typeof response.text === 'function') {
      const encoded = await response.text()
      if (Buffer.byteLength(encoded, 'utf8') > MAX_CATALOG_RESPONSE_BYTES) throw new Error('remote unavailable')
      try { body = JSON.parse(encoded) } catch { throw new Error('remote unavailable') }
    } else {
      body = await response.json()
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_CATALOG_RESPONSE_BYTES) throw new Error('remote unavailable')
    }
    if (!body || !Array.isArray(body.data) || body.data.length > 256) throw new Error('remote unavailable')
    const ids = body.data.map((item) => item?.id)
    if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256) || new Set(ids).size !== ids.length) {
      throw new Error('remote unavailable')
    }
    return ids.map((modelId) => ({ modelId, capabilitySuggestion: null }))
  }
}

module.exports = { OpenAiCompatibleAdapter }
