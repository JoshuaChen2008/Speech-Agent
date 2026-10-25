'use strict'

const { canonicalizeConnection, joinEndpoint } = require('./connection')
const { encodeExchangeRequest, normalizeExchangeResponse, exchangeError } = require('../contracts/provider-exchange')
const { outputInvalid, outputValidationFor } = require('../contracts/output-validation')
const { parseRetryAfter } = require('../contracts/retry-policy')

function providerResponseError (status, testMode) {
  if (status >= 300 && status < 400) return exchangeError(testMode ? 'REDIRECT_REJECTED' : 'AGENT_REQUEST_INVALID')
  if (status === 401 || status === 403) return exchangeError('AGENT_PROVIDER_AUTH_FAILED')
  if (status === 408 || status === 504) return exchangeError('AGENT_PROVIDER_TIMEOUT', true)
  if (status === 429) return exchangeError('AGENT_PROVIDER_RATE_LIMITED', true)
  if ([409, 425].includes(status) || status >= 500) return exchangeError('AGENT_PROVIDER_UNAVAILABLE', true)
  return exchangeError('AGENT_REQUEST_INVALID')
}

function notify (observer, type) {
  try { Promise.resolve(observer?.(Object.freeze({ type }))).catch(() => {}) } catch {}
}

function cancelReader (reader) {
  try { Promise.resolve(reader.cancel()).catch(() => {}) } catch {}
}

function classifiedOutput (error) {
  const value = outputValidationFor(error)
  return outputInvalid(value.reason === 'unknown' ? 'response_protocol' : value.reason, value.field, value.actual, value.limit)
}

async function readResponse (response, maximum, signal, discard, quality) {
  const declared = response?.headers?.get?.('content-length')
  const length = typeof declared === 'string' && /^\d+$/u.test(declared) ? Number(declared) : null
  if (length !== null && length > maximum) {
    try { Promise.resolve(response.body?.cancel?.()).catch(() => {}) } catch {}
    throw quality ? outputInvalid('transport_size', 'response', length, maximum) : outputInvalid('response_protocol', 'response')
  }
  // Empty HTTP error bodies carry no protocol data. Successful responses must
  // supply a readable byte stream; text()/json() cannot enforce a read limit.
  if (discard && response.body == null) return null
  if (typeof response.body?.getReader !== 'function') throw outputInvalid('response_protocol', 'response')
  const reader = response.body.getReader()
  const chunks = []; let size = 0; let cancelled = false
  const cancel = () => { chunks.length = 0; if (!cancelled) { cancelled = true; cancelReader(reader) } }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw exchangeError('AGENT_CANCELLED')
      const { value, done } = await reader.read()
      if (signal.aborted) throw exchangeError('AGENT_CANCELLED')
      if (done) break
      if (!(value instanceof Uint8Array)) throw outputInvalid('response_protocol', 'response')
      size += value.byteLength
      if (size > maximum) throw quality ? outputInvalid('transport_size', 'response', size, maximum) : outputInvalid('response_protocol', 'response')
      if (!discard) chunks.push(Buffer.from(value))
    }
    if (discard) return null
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { throw outputInvalid('response_protocol', 'response') }
  } catch (error) {
    if (signal.aborted) throw exchangeError('AGENT_CANCELLED')
    if (error?.code === 'AGENT_OUTPUT_INVALID') throw classifiedOutput(error)
    if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw exchangeError('AGENT_PROVIDER_TIMEOUT')
    }
    throw outputInvalid('response_protocol', 'response')
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    try { reader.releaseLock() } catch {}
  }
}

async function exchange ({ fetch, connection, credential, resolvedModel, requestStrategy, request, signal, onProgress, testMode = false }) {
  const body = encodeExchangeRequest({ request, resolvedModel, requestStrategy, testMode })
  const { timeoutMs, maxResponseBytes } = request.limits
  const usageReporting = resolvedModel?.capabilities?.usageReporting !== false
  let endpoint
  try { endpoint = canonicalizeConnection(connection.httpsOrigin, connection.basePath) } catch { throw exchangeError('AGENT_REQUEST_INVALID') }
  if (!Buffer.isBuffer(credential) || !credential.length) throw exchangeError('AGENT_PROVIDER_AUTH_FAILED')
  if (signal?.aborted) throw exchangeError('AGENT_CANCELLED')
  const controller = new AbortController()
  let rejectControl; let settled = false
  const control = new Promise((resolve, reject) => { rejectControl = reject })
  const stop = code => {
    if (settled) return
    settled = true
    rejectControl(exchangeError(code, code === 'AGENT_PROVIDER_TIMEOUT'))
    controller.abort()
  }
  const cancel = () => stop('AGENT_CANCELLED')
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => stop('AGENT_PROVIDER_TIMEOUT'), timeoutMs)
  const headers = { authorization: `Bearer ${credential.toString('utf8')}`, 'content-type': 'application/json' }
  const work = (async () => {
    let response
    try {
      // The only HTTP invocation in this operation; no retry or tool objects.
      let pending
      try {
        pending = fetch(joinEndpoint(endpoint, '/chat/completions'), {
          method: 'POST', redirect: 'manual', headers, body, signal: controller.signal
        })
      } finally { notify(onProgress, 'request_started') }
      response = await pending
    } catch {
      if (controller.signal.aborted) throw exchangeError('AGENT_CANCELLED')
      throw exchangeError('AGENT_PROVIDER_UNAVAILABLE', true)
    }
    if (controller.signal.aborted || settled) {
      try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}) } catch {}
      throw exchangeError('AGENT_CANCELLED')
    }
    notify(onProgress, 'response_received')
    const status = Number.isSafeInteger(response?.status) ? response.status : 0
    const ok = !(status >= 300 && status < 400) && (response?.ok === true || (status >= 200 && status < 300))
    if (response?.url) {
      try { if (new URL(response.url).origin !== endpoint.httpsOrigin) throw new Error('origin') } catch {
        try { Promise.resolve(response.body?.cancel?.()).catch(() => {}) } catch {}
        throw exchangeError('AGENT_REQUEST_INVALID')
      }
    }
    const payload = await readResponse(response, maxResponseBytes, controller.signal, !ok, requestStrategy === 'deepseek-openai@2')
    if (!ok) {
      const error = providerResponseError(status, testMode)
      if (error.retryable === true) error.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'))
      throw error
    }
    return normalizeExchangeResponse(payload, usageReporting, requestStrategy)
  })()
  work.catch(() => {})
  try {
    const result = await Promise.race([work, control])
    if (signal?.aborted) throw exchangeError('AGENT_CANCELLED')
    return result
  } catch (error) {
    if (signal?.aborted) throw exchangeError('AGENT_CANCELLED')
    if (error?.code === 'AGENT_OUTPUT_INVALID') throw classifiedOutput(error)
    if (['AGENT_REQUEST_INVALID', 'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_UNAVAILABLE',
      'AGENT_PROVIDER_TIMEOUT', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_CANCELLED', 'REDIRECT_REJECTED'].includes(error?.code)) {
      // Project classification only; a response reader must never forward its
      // original message, stack, body or arbitrary attached fields.
      const classified = exchangeError(error.code, error.code === 'AGENT_PROVIDER_TIMEOUT'
        ? error.retryable === true
        : ['AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_RATE_LIMITED'].includes(error.code))
      if (classified.retryable && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0) classified.retryAfterMs = error.retryAfterMs
      throw classified
    }
    throw outputInvalid('response_protocol', 'response')
  } finally {
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    headers.authorization = ''
    controller.abort()
  }
}

module.exports = { exchange }
