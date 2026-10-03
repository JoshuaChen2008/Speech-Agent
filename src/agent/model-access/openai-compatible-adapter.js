'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { normalizeDeepSeekUsage } = require('../contracts/model-access-core')
const { TOOL_PAYLOAD_LIMITS, deriveRecipeRequestCapacity, deriveRecipeOutboundQuota, usesModelWindowCapacity } = require('../contracts/budget-axes')
const { canonicalizeConnection, joinEndpoint } = require('./connection')

const MAX_CATALOG_RESPONSE_BYTES = 256 * 1024
const MAX_COMPLETION_RESPONSE_BYTES = 512 * 1024
const MAX_TEST_RESPONSE_BYTES = 64 * 1024
const MAX_COMPLETION_REQUEST_BYTES = 512 * 1024
const MAX_TOOL_MESSAGE_BYTES = TOOL_PAYLOAD_LIMITS.maxResultBytes
const MAX_TOOL_ARGUMENT_BYTES = TOOL_PAYLOAD_LIMITS.maxArgsBytes
const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_TIMEOUT_MS = 180 * 1000
const REQUEST_STRATEGIES = new Set(['openai-compatible@1', 'deepseek-openai@1', 'qwen-beijing@1'])

function codedError (code, retryable = undefined) {
  const error = new Error(code)
  error.code = code
  if (retryable !== undefined) error.retryable = retryable
  return error
}

function providerResponseError (status) {
  if (status === 401 || status === 403) return codedError('AGENT_PROVIDER_AUTH_FAILED', false)
  if ([400, 404, 422].includes(status)) return codedError('AGENT_REQUEST_INVALID', false)
  if (status === 408 || status === 504) return codedError('AGENT_PROVIDER_TIMEOUT', true)
  if (status === 429) return codedError('AGENT_PROVIDER_RATE_LIMITED', true)
  if ([409, 425].includes(status) || status >= 500) return codedError('AGENT_PROVIDER_UNAVAILABLE', true)
  return codedError('AGENT_REQUEST_INVALID', false)
}

function responseStatus (response) {
  return Number.isSafeInteger(response?.status) ? response.status : 0
}

function notifyProgress (onProgress, event) {
  if (typeof onProgress !== 'function') return
  try { Promise.resolve(onProgress(Object.freeze(event))).catch(() => {}) } catch { /* progress observers are isolated from provider calls */ }
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

// The windowed direct-summary request capacity is a host-internal parameter
// derived by the runner from the frozen binding. summary.minutes@2 fails
// closed without it rather than falling back to the raw model output
// capability; no other recipe may carry it.
function assertRequestCapacity (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'promptByteLimit,requestOutputTokens' ||
      !Number.isSafeInteger(value.requestOutputTokens) || value.requestOutputTokens < 1 ||
      !Number.isSafeInteger(value.promptByteLimit) || value.promptByteLimit < 0) {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  return value
}

function inputCapacityError (actual, limit) {
  const error = codedError('AGENT_QA_INPUT_LIMIT_EXCEEDED', false)
  error.diagnosticMetrics = { actual, limit, unit: 'bytes' }
  return error
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
    recipe,
    systemPrompt = '',
    prompt,
    tools = [],
    maxTurns = 1,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    onProgress,
    beforeRequest,
    getRunUsage,
    onRequestUsage,
    shouldStopAfterTurn = null,
    requestCapacity,
    requestStrategy = 'openai-compatible@1',
    testMode = false
  } = {}) {
    if (!REQUEST_STRATEGIES.has(requestStrategy)) throw codedError('AGENT_REQUEST_INVALID')
    const endpointConnection = safeConnection(connection)
    const credentialBuffer = safeCredential(credential)
    const model = modelIdFor(resolvedModel)
    const maxOutputTokens = resolvedModel?.capabilities?.maxOutputTokens
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw codedError('AGENT_REQUEST_INVALID')
    boundedText(systemPrompt, 16 * 1024)
    const windowedInput = usesModelWindowCapacity(recipe?.recipeId, recipe?.recipeVersion)
    const windowedQuestion = recipe?.recipeId === 'qa.answer' && usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
    if (windowedInput) assertRequestCapacity(requestCapacity)
    else if (requestCapacity !== undefined) throw codedError('AGENT_REQUEST_INVALID')
    boundedText(prompt, windowedInput
      ? 256 * 1024
      : 16 * 1024)
    if (windowedQuestion) {
      const expected = deriveRecipeRequestCapacity({ recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion,
        capabilities: resolvedModel.capabilities, budget: resolvedModel.budget })
      if (expected.promptByteLimit !== requestCapacity.promptByteLimit ||
          expected.requestOutputTokens !== requestCapacity.requestOutputTokens) throw codedError('AGENT_REQUEST_INVALID')
      const actual = Buffer.byteLength(prompt, 'utf8')
      if (actual > expected.promptByteLimit) throw inputCapacityError(actual, expected.promptByteLimit)
    }
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
      // Every outbound — first request, retry, and post-tool follow-up —
      // re-derives the v2 output quota and input window from one budget-axes
      // rule. Known consumption accumulates from provider usage; unknown usage
      // keeps the remaining budget unconstrained instead of assuming zero. A
      // zero output balance rejects here with no further egress.
      let maxTokensForRequest = maxOutputTokens
      let inputWindowBytes = null
      const runUsage = typeof getRunUsage === 'function' ? await getRunUsage() : null
      if (windowedInput) {
        const quota = deriveRecipeOutboundQuota({
          recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion,
          capabilities: resolvedModel.capabilities,
          budget: resolvedModel.budget,
          knownCumulativeOutputTokens: runUsage ? (runUsage.known ? runUsage.outputTokens : null) : (usageKnown ? outputTokens : null)
        })
        maxTokensForRequest = quota.requestOutputTokens
        inputWindowBytes = quota.requestInputByteWindow
      }
      const body = {
        model,
        messages,
        max_tokens: maxTokensForRequest,
        ...(declarations.length > 0 ? { tools: declarations, tool_choice: 'auto' } : {}),
        ...(testMode || resolvedModel?.capabilities?.supportsStructuredOutput === true
          ? { response_format: { type: 'json_object' } }
          : {}),
        ...(requestStrategy === 'deepseek-openai@1' ? { thinking: { type: 'disabled' } } : {}),
        ...(requestStrategy === 'qwen-beijing@1' ? { enable_thinking: false } : {})
      }
      let requestBody
      try { requestBody = canonicalize(body) } catch { throw codedError('AGENT_REQUEST_INVALID') }
      if (Buffer.byteLength(requestBody, 'utf8') > MAX_COMPLETION_REQUEST_BYTES) throw codedError('AGENT_BUDGET_EXCEEDED')
      // The fixed envelope reserve only covers wrapper overhead; growing tool
      // messages and declarations must still fit the registered input window.
      if (inputWindowBytes !== null) {
        const inputPortion = canonicalize(declarations.length > 0 ? { messages, tools: declarations } : { messages })
        const actual = Buffer.byteLength(inputPortion, 'utf8')
        if (actual > inputWindowBytes) {
          if (windowedQuestion && turn === 0) throw inputCapacityError(actual, inputWindowBytes)
          throw codedError('AGENT_BUDGET_EXCEEDED')
        }
      }
      let controller
      let timedOut = false
      let timeoutHandle
      let removeAbortListener = null
      let requestHeaders = null
      let responseReceived = false
      let rejectRequestControl
      let requestControlSettled = false
      const requestControl = new Promise((resolve, reject) => { rejectRequestControl = reject })
      const settleRequestControl = (error) => {
        if (requestControlSettled) return
        requestControlSettled = true
        rejectRequestControl(error)
      }
      const requestSignal = (() => {
        if (typeof AbortController === 'function') controller = new AbortController()
        const abort = () => {
          try { controller?.abort() } catch {}
          settleRequestControl(codedError('AGENT_CANCELLED', false))
        }
        if (signal) {
          if (signal.aborted) abort()
          else {
            signal.addEventListener('abort', abort, { once: true })
            removeAbortListener = () => signal.removeEventListener('abort', abort)
          }
        }
        timeoutHandle = setTimeout(() => {
          timedOut = true
          try { controller?.abort() } catch {}
          settleRequestControl(codedError('AGENT_PROVIDER_TIMEOUT', true))
        }, remaining)
        return controller?.signal || signal
      })()
      try {
        requestHeaders = {
          // The only string conversion happens for the live fetch call. The
          // mutable header object is cleared as soon as the call settles.
          authorization: `Bearer ${credentialBuffer.toString('utf8')}`,
          'content-type': 'application/json'
        }
        const requestTurn = turn + 1
        let payload
        const maximum = testMode || typeof beforeRequest !== 'function' ? 1 : 5
        for (let requestAttempt = 1; requestAttempt <= maximum; requestAttempt++) {
          if (typeof beforeRequest === 'function') await beforeRequest(Object.freeze({ turn: requestTurn, requestAttempt }))
          if (signal?.aborted) {
            throw codedError(signal.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_CANCELLED', false)
          }
          responseReceived = false
          let responsePromise
          try {
            responsePromise = this.fetch(joinEndpoint(endpointConnection, '/chat/completions'), {
              method: 'POST', redirect: 'manual', headers: requestHeaders,
              body: requestBody, signal: requestSignal
            })
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            responsePromise = Promise.reject(codedError('AGENT_PROVIDER_UNAVAILABLE', true))
          } finally {
            notifyProgress(onProgress, { type: 'request_started', turn: requestTurn })
          }
          const responseProcessing = Promise.resolve(responsePromise).catch((error) => {
            if (error?.name === 'AbortError') throw error
            throw codedError('AGENT_PROVIDER_UNAVAILABLE', true)
          }).then(async (response) => {
            responseReceived = true
            notifyProgress(onProgress, { type: 'response_received', turn: requestTurn })
            const status = responseStatus(response)
            if (status >= 300 && status < 400) throw codedError(testMode ? 'REDIRECT_REJECTED' : 'AGENT_REQUEST_INVALID', false)
            if (!responseOk(response)) throw providerResponseError(status)
            return boundedJson(response, testMode ? MAX_TEST_RESPONSE_BYTES : MAX_COMPLETION_RESPONSE_BYTES, 'AGENT_OUTPUT_INVALID')
          })
          // A non-cooperative fetch or body read must not retain the host run.
          responseProcessing.catch(() => {})
          try {
            payload = await Promise.race([responseProcessing, requestControl])
            break
          } catch (error) {
            // A failed outbound request has no trustworthy usage receipt.
            // Later successful requests cannot make the run total known again.
            usageKnown = false
            if (typeof onRequestUsage === 'function') await onRequestUsage(null)
            const retryable = error?.retryable === true || (!responseReceived && !error?.code && error?.name !== 'AbortError')
            if (!retryable || requestAttempt >= maximum || signal?.aborted || timedOut) {
              if (retryable && requestAttempt >= maximum && maximum === 5 && error) error.retryExhausted = true
              throw error
            }
            const delayMs = Math.min(1000, 100 * (2 ** (requestAttempt - 1)))
            notifyProgress(onProgress, { type: 'retry_wait', phase: 'waiting_model', activity: false, turn: requestTurn,
              requestAttempt, nextAttempt: requestAttempt + 1, reason: error?.code || 'AGENT_PROVIDER_UNAVAILABLE', waitMs: delayMs })
            await Promise.race([new Promise((resolve) => setTimeout(resolve, delayMs)), requestControl])
          }
        }
        // The request deadline bounds fetch and response decoding. Tool calls
        // use their own bounded race against the same overall deadline.
        clearTimeout(timeoutHandle)
        timeoutHandle = null
        const choice = payload?.choices?.[0]
        const message = choice?.message
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw codedError('AGENT_OUTPUT_INVALID')
        // Closed finish_reason set, checked before any tool execution or
        // content hand-off: length, content_filter, a missing or unknown
        // reason, a stop/tool_calls contradiction, and tool_calls without
        // calls all fail closed as invalid output with no tool side effects
        // and no automatic retry.
        const finishReason = choice.finish_reason
        if (finishReason !== 'stop' && finishReason !== 'tool_calls') throw codedError('AGENT_OUTPUT_INVALID')
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(toolCallProjection) : []
        if (finishReason === 'stop' && calls.length > 0) throw codedError('AGENT_OUTPUT_INVALID')
        if (finishReason === 'tool_calls' && calls.length === 0) throw codedError('AGENT_OUTPUT_INVALID')
        if (typeof onRequestUsage === 'function') await onRequestUsage(normalizeDeepSeekUsage(payload.usage, resolvedModel?.capabilities?.usageReporting !== false))
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
              /^\s*$/u.test(message.content) ||
              Buffer.byteLength(message.content, 'utf8') > MAX_COMPLETION_RESPONSE_BYTES) {
            throw codedError('AGENT_OUTPUT_INVALID')
          }
          if (testMode) {
            try {
              const testPayload = JSON.parse(message.content)
              if (!testPayload || typeof testPayload !== 'object' || Array.isArray(testPayload) ||
                  Object.keys(testPayload).length !== 1 || testPayload.ok !== true) throw new Error('test response')
            } catch { throw codedError('AGENT_OUTPUT_INVALID') }
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
        if (!responseReceived) notifyProgress(onProgress, { type: 'request_failed', turn: turn + 1 })
        if (signal?.aborted) throw codedError('AGENT_CANCELLED', false)
        if (timedOut || error?.name === 'AbortError') throw codedError('AGENT_PROVIDER_TIMEOUT', true)
        if (error?.code) throw error
        throw codedError('AGENT_INTERNAL_FAILURE', false)
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
