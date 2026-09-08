'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { normalizeDeepSeekUsage } = require('../contracts/model-access-core')
const { TOOL_PAYLOAD_LIMITS } = require('../contracts/budget-axes')
const { canonicalizeConnection, joinEndpoint } = require('./connection')

const MAX_CATALOG_RESPONSE_BYTES = 256 * 1024
const MAX_COMPLETION_RESPONSE_BYTES = 512 * 1024
const MAX_COMPLETION_REQUEST_BYTES = 512 * 1024
const MAX_TOOL_MESSAGE_BYTES = TOOL_PAYLOAD_LIMITS.maxResultBytes
const MAX_TOOL_ARGUMENT_BYTES = TOOL_PAYLOAD_LIMITS.maxArgsBytes
const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_TIMEOUT_MS = 180 * 1000

function codedError (code, retryable = undefined) {
  const error = new Error(code)
  error.code = code
  if (retryable !== undefined) error.retryable = retryable
  return error
}

function providerResponseError (status) {
  if (status === 401 || status === 403) return codedError('AGENT_PROVIDER_AUTH_FAILED', false)
  if (status === 408 || status === 504) return codedError('AGENT_PROVIDER_TIMEOUT', true)
  if (status === 429) return codedError('AGENT_PROVIDER_RATE_LIMITED', true)
  return codedError('AGENT_PROVIDER_UNAVAILABLE', true)
}

function responseStatus (response) {
  return Number.isSafeInteger(response?.status) ? response.status : 0
}

function responseOk (response) {
  const status = responseStatus(response)
  return response?.ok === true || (status >= 200 && status < 300)
}

function declaredLength (response) {
  const value = Number(response?.headers?.get?.('content-length'))
  return Number.isFinite(value) && value >= 0 ? value : null
}

async function boundedJson (response, maximum, failureCode = 'AGENT_PROVIDER_UNAVAILABLE') {
  const length = declaredLength(response)
  if (length !== null && length > maximum) throw codedError(failureCode, failureCode === 'AGENT_OUTPUT_INVALID' ? false : true)
  let encoded
  try {
    if (typeof response?.text === 'function') encoded = await response.text()
    else if (typeof response?.json === 'function') encoded = JSON.stringify(await response.json())
    else throw new Error('response body unavailable')
  } catch (error) {
    if (error?.code) throw error
    if (error?.name === 'AbortError') throw error
    throw codedError(failureCode, failureCode === 'AGENT_OUTPUT_INVALID' ? false : true)
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maximum) {
    throw codedError(failureCode, failureCode === 'AGENT_OUTPUT_INVALID' ? false : true)
  }
  try { return JSON.parse(encoded) } catch { throw codedError(failureCode, failureCode === 'AGENT_OUTPUT_INVALID' ? false : true) }
}

function safeConnection (connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw codedError('AGENT_REQUEST_INVALID')
  try { return canonicalizeConnection(connection.httpsOrigin, connection.basePath) } catch { throw codedError('AGENT_REQUEST_INVALID') }
}

function safeCredential (credential) {
  if (!Buffer.isBuffer(credential) || credential.length === 0) throw codedError('AGENT_PROVIDER_AUTH_FAILED', false)
  return credential
}

function boundedText (value, maximum, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw codedError(code, code === 'AGENT_REQUEST_INVALID' ? false : undefined)
  }
  return value
}

function modelIdFor (resolvedModel) {
  const modelId = resolvedModel?.modelId || resolvedModel?.model_id
  if (typeof modelId !== 'string' || modelId.length === 0) throw codedError('AGENT_REQUEST_INVALID')
  return boundedText(modelId, 256)
}

function toolDeclaration (tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name) || typeof tool.execute !== 'function') {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  const description = tool.description === undefined ? undefined : boundedText(tool.description, 512)
  const parameters = tool.parameters === undefined
    ? { type: 'object', additionalProperties: true }
    : tool.parameters
  try {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
        Buffer.byteLength(canonicalize(parameters), 'utf8') > 16 * 1024) throw new Error('tool schema')
  } catch { throw codedError('AGENT_REQUEST_INVALID') }
  const declaration = {
    type: 'function',
    function: { name: tool.name, parameters }
  }
  if (description !== undefined) declaration.function.description = description
  return declaration
}

function toolCallProjection (call) {
  const id = boundedText(call?.id, 256, 'AGENT_OUTPUT_INVALID')
  const name = boundedText(call?.function?.name, 128, 'AGENT_OUTPUT_INVALID')
  if (id.length === 0 || name.length === 0) throw codedError('AGENT_OUTPUT_INVALID')
  const args = boundedText(call?.function?.arguments, MAX_TOOL_ARGUMENT_BYTES, 'AGENT_OUTPUT_INVALID')
  let parsed
  try {
    parsed = JSON.parse(args)
  } catch { throw codedError('AGENT_OUTPUT_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw codedError('AGENT_OUTPUT_INVALID')
  return { id, name, arguments: parsed, rawArguments: args }
}

function toolMessage (toolCallId, result) {
  let content
  try { content = canonicalize(result === undefined ? null : result) } catch { throw codedError('AGENT_OUTPUT_INVALID') }
  if (Buffer.byteLength(content, 'utf8') > MAX_TOOL_MESSAGE_BYTES) throw codedError('AGENT_BUDGET_EXCEEDED')
  return { role: 'tool', tool_call_id: toolCallId, content }
}

const TOOL_ERROR_CODES = new Set(['TOOL_ARGS_INVALID', 'TOOL_SCOPE_DENIED', 'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'TOOL_INTERNAL_FAILURE'])

async function executeToolBounded (tool, args, signal, timeoutMs) {
  if (signal?.aborted) throw codedError('TOOL_CANCELLED', false)
  let timeoutHandle
  let removeAbortListener = null
  let rejectControl
  const control = new Promise((resolve, reject) => { rejectControl = reject })
  const toolPromise = Promise.resolve().then(() => tool.execute(args, { signal, timeoutMs }))
  // A timed-out provider call must not turn a later tool rejection into an
  // unhandled rejection. The result is intentionally discarded after the
  // bounded race settles.
  toolPromise.catch(() => {})
  if (signal) {
    const abort = () => rejectControl(codedError('TOOL_CANCELLED', false))
    if (signal.aborted) abort()
    else {
      signal.addEventListener('abort', abort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', abort)
    }
  }
  timeoutHandle = setTimeout(() => rejectControl(codedError('TOOL_TIMEOUT', true)), timeoutMs)
  try {
    return await Promise.race([toolPromise, control])
  } catch (error) {
    if (error?.code && TOOL_ERROR_CODES.has(error.code)) throw error
    throw codedError('TOOL_INTERNAL_FAILURE', false)
  } finally {
    clearTimeout(timeoutHandle)
    try { removeAbortListener?.() } catch {}
  }
}

class OpenAiCompatibleAdapter {
  constructor (options = {}) {
    this.fetch = options.fetch || globalThis.fetch
    if (typeof this.fetch !== 'function') throw new TypeError('fetch is required')
  }

  async listModels ({ connection, credential, signal }) {
    const headers = { authorization: `Bearer ${credential.toString('utf8')}` }
    try {
      const response = await this.fetch(joinEndpoint(connection, '/models'), {
        method: 'GET',
        redirect: 'manual',
        headers,
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
    } finally {
      headers.authorization = ''
    }
  }

  async run ({
    connection,
    credential,
    resolvedModel,
    systemPrompt = '',
    prompt,
    tools = [],
    maxTurns = 1,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    shouldStopAfterTurn = null
  } = {}) {
    const endpointConnection = safeConnection(connection)
    const credentialBuffer = safeCredential(credential)
    const model = modelIdFor(resolvedModel)
    const maxOutputTokens = resolvedModel?.capabilities?.maxOutputTokens
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw codedError('AGENT_REQUEST_INVALID')
    boundedText(systemPrompt, 16 * 1024)
    boundedText(prompt, 16 * 1024)
    if (!Array.isArray(tools) || tools.length > 16) throw codedError('AGENT_REQUEST_INVALID')
    const declarations = tools.map(toolDeclaration)
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
    if (declarations.length > 0 && resolvedModel?.capabilities?.supportsToolCalling !== true) {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 6) throw codedError('AGENT_REQUEST_INVALID')
    const effectiveTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS
    const messages = []
    if (systemPrompt.length > 0) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: prompt })
    let turn = 0
    let toolCalls = 0
    let usageKnown = true
    let cacheKnown = true
    let inputTokens = 0
    let outputTokens = 0
    let cacheHitInputTokens = 0
    let cacheMissInputTokens = 0
    const deadline = Date.now() + effectiveTimeout

    while (turn < maxTurns) {
      if (signal?.aborted) throw codedError('AGENT_CANCELLED', false)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw codedError('AGENT_PROVIDER_TIMEOUT', true)
      const body = {
        model,
        messages,
        max_tokens: maxOutputTokens,
        ...(declarations.length > 0 ? { tools: declarations, tool_choice: 'auto' } : {}),
        ...(resolvedModel?.capabilities?.supportsStructuredOutput === true
          ? { response_format: { type: 'json_object' } }
          : {})
      }
      let requestBody
      try { requestBody = canonicalize(body) } catch { throw codedError('AGENT_REQUEST_INVALID') }
      if (Buffer.byteLength(requestBody, 'utf8') > MAX_COMPLETION_REQUEST_BYTES) throw codedError('AGENT_BUDGET_EXCEEDED')
      let controller
      let timedOut = false
      let timeoutHandle
      let removeAbortListener = null
      let requestHeaders = null
      const requestSignal = (() => {
        if (typeof AbortController !== 'function') return signal
        controller = new AbortController()
        const abort = () => controller.abort()
        if (signal) {
          if (signal.aborted) controller.abort()
          else {
            signal.addEventListener('abort', abort, { once: true })
            removeAbortListener = () => signal.removeEventListener('abort', abort)
          }
        }
        timeoutHandle = setTimeout(() => { timedOut = true; controller.abort() }, remaining)
        return controller.signal
      })()
      try {
        requestHeaders = {
          // The only string conversion happens for the live fetch call. The
          // mutable header object is cleared as soon as the call settles.
          authorization: `Bearer ${credentialBuffer.toString('utf8')}`,
          'content-type': 'application/json'
        }
        const response = await this.fetch(joinEndpoint(endpointConnection, '/chat/completions'), {
          method: 'POST',
          redirect: 'manual',
          headers: requestHeaders,
          body: requestBody,
          signal: requestSignal
        })
        const status = responseStatus(response)
        if (status >= 300 && status < 400) throw codedError('AGENT_PROVIDER_UNAVAILABLE', true)
        if (!responseOk(response)) throw providerResponseError(status)
        const payload = await boundedJson(response, MAX_COMPLETION_RESPONSE_BYTES, 'AGENT_OUTPUT_INVALID')
        // The request deadline bounds fetch and response decoding. Tool calls
        // use their own bounded race against the same overall deadline.
        clearTimeout(timeoutHandle)
        timeoutHandle = null
        const choice = payload?.choices?.[0]
        const message = choice?.message
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw codedError('AGENT_OUTPUT_INVALID')
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(toolCallProjection) : []
        turn += 1
        const usage = normalizeDeepSeekUsage(payload.usage, resolvedModel?.capabilities?.usageReporting !== false)
        if (!usage) usageKnown = false
        else if (usageKnown) {
          inputTokens += usage.inputTokens
          outputTokens += usage.outputTokens
          if (usage.cacheHitInputTokens === null) cacheKnown = false
          else if (cacheKnown) {
            cacheHitInputTokens += usage.cacheHitInputTokens
            cacheMissInputTokens += usage.cacheMissInputTokens
          }
        }
        if (calls.length === 0) {
          if (typeof message.content !== 'string' || message.content.length === 0 ||
              Buffer.byteLength(message.content, 'utf8') > MAX_COMPLETION_RESPONSE_BYTES) {
            throw codedError('AGENT_OUTPUT_INVALID')
          }
          return {
            text: message.content,
            usage: usageKnown
              ? {
                  inputTokens,
                  outputTokens,
                  usageSource: 'provider',
                  cacheHitInputTokens: cacheKnown ? cacheHitInputTokens : null,
                  cacheMissInputTokens: cacheKnown ? cacheMissInputTokens : null
                }
              : null
          }
        }
        if (shouldStopAfterTurn?.({ turn, toolCalls: toolCalls + calls.length }) === true) {
          throw codedError('AGENT_BUDGET_EXCEEDED')
        }
        const assistantMessage = {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.rawArguments }
          }))
        }
        messages.push(assistantMessage)
        for (const call of calls) {
          const tool = toolByName.get(call.name)
          if (!tool) throw codedError('AGENT_OUTPUT_INVALID')
          const remainingForTool = deadline - Date.now()
          if (remainingForTool <= 0) throw codedError('TOOL_TIMEOUT', true)
          const configuredToolTimeout = resolvedModel?.budget?.toolTimeoutMs
          const toolTimeout = Number.isSafeInteger(configuredToolTimeout) && configuredToolTimeout > 0
            ? Math.min(remainingForTool, configuredToolTimeout)
            : remainingForTool
          const result = await executeToolBounded(tool, call.arguments, signal, toolTimeout)
          messages.push(toolMessage(call.id, result))
          toolCalls += 1
        }
      } catch (error) {
        if (signal?.aborted) throw codedError('AGENT_CANCELLED', false)
        if (timedOut || error?.name === 'AbortError') throw codedError('AGENT_PROVIDER_TIMEOUT', true)
        if (error?.code) throw error
        throw codedError('AGENT_PROVIDER_UNAVAILABLE', true)
      } finally {
        clearTimeout(timeoutHandle)
        if (requestHeaders) requestHeaders.authorization = ''
        try { removeAbortListener?.() } catch {}
      }
    }
    throw codedError('AGENT_BUDGET_EXCEEDED')
  }
}

module.exports = { OpenAiCompatibleAdapter }
