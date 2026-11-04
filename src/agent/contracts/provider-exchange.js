'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { normalizeDeepSeekUsage } = require('./model-access-core')
const { outputInvalid } = require('./output-validation')
const { TOOL_PAYLOAD_LIMITS } = require('./budget-axes')

const EXCHANGE_VERSION = 1
const EXCHANGE_LIMITS = Object.freeze({ maxRequestBytes: 512 * 1024, maxResponseBytes: 512 * 1024, maxTimeoutMs: 180 * 1000 })
const QUALITY_EXCHANGE_LIMITS = Object.freeze({ maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024, maxTimeoutMs: 600000 })
const REQUEST_STRATEGIES = Object.freeze(['openai-compatible@1', 'deepseek-openai@1', 'qwen-beijing@1', 'deepseek-openai@2'])
function limitsForStrategy (strategy) { return strategy === 'deepseek-openai@2' ? QUALITY_EXCHANGE_LIMITS : EXCHANGE_LIMITS }
const FINISH_REASONS = Object.freeze(['stop', 'tool_calls', 'length', 'content_filter', 'insufficient_system_resource', 'aborted'])

function exchangeError (code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable })
}

function exact (value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw exchangeError('AGENT_REQUEST_INVALID')
  }
}

function checkedText (value, maximum, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) throw exchangeError(code)
  return value
}

function apiCall (call) {
  exact(call, ['id', 'name', 'arguments', 'rawArguments'])
  checkedText(call.id, 256); checkedText(call.name, 128)
  checkedText(call.rawArguments, TOOL_PAYLOAD_LIMITS.maxArgsBytes)
  // Preserve the checked provider argument bytes for old request strategies.
  if (canonicalize(JSON.parse(call.rawArguments)) !== canonicalize(call.arguments)) throw exchangeError('AGENT_REQUEST_INVALID')
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArguments } }
}

function apiMessage (message, strategy) {
  const limits = limitsForStrategy(strategy)
  if (!message || typeof message !== 'object') throw exchangeError('AGENT_REQUEST_INVALID')
  if (['system', 'user'].includes(message.role)) {
    exact(message, ['role', 'content']); checkedText(message.content, limits.maxRequestBytes)
    return { role: message.role, content: message.content }
  }
  if (message.role === 'tool') {
    exact(message, ['role', 'toolCallId', 'content'])
    checkedText(message.toolCallId, 256); checkedText(message.content, TOOL_PAYLOAD_LIMITS.maxResultBytes)
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant') {
    exact(message, ['role', 'content', 'toolCalls'], strategy === 'deepseek-openai@2' ? ['thinking'] : [])
    if (message.content !== null) checkedText(message.content, limits.maxResponseBytes)
    if (!Array.isArray(message.toolCalls) || message.toolCalls.length > 16) throw exchangeError('AGENT_REQUEST_INVALID')
    return { role: 'assistant', content: message.content, tool_calls: message.toolCalls.map(apiCall),
      ...(strategy === 'deepseek-openai@2' && message.thinking !== undefined ? { reasoning_content: checkedText(message.thinking, limits.maxResponseBytes) } : {}) }
  }
  throw exchangeError('AGENT_REQUEST_INVALID')
}

function apiTool (tool) {
  exact(tool, ['name', 'parameters'], ['description'])
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name) ||
      !tool.parameters || Object.getPrototypeOf(tool.parameters) !== Object.prototype ||
      Buffer.byteLength(canonicalize(tool.parameters), 'utf8') > 16 * 1024) throw exchangeError('AGENT_REQUEST_INVALID')
  const declaration = { type: 'function', function: { name: tool.name, parameters: tool.parameters } }
  if (tool.description !== undefined) declaration.function.description = checkedText(tool.description, 512)
  return declaration
}

function encodeExchangeRequest ({ request, resolvedModel, requestStrategy = 'openai-compatible@1', testMode = false }) {
  try {
    exact(request, ['schemaVersion', 'messages', 'tools', 'outputContract', 'limits'])
    if (request.schemaVersion !== EXCHANGE_VERSION || !REQUEST_STRATEGIES.includes(requestStrategy) ||
        !Array.isArray(request.messages) || request.messages.length < 1 ||
        !Array.isArray(request.tools) || request.tools.length > 16) throw exchangeError('AGENT_REQUEST_INVALID')
    const { limits, outputContract } = request
    const protocolLimits = limitsForStrategy(requestStrategy)
    exact(limits, ['maxOutputTokens', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs', 'inputByteLimit', 'inputLimitError'])
    for (const [key, ceiling] of Object.entries({ maxOutputTokens: resolvedModel?.capabilities?.maxOutputTokens,
      maxRequestBytes: protocolLimits.maxRequestBytes, maxResponseBytes: protocolLimits.maxResponseBytes,
      timeoutMs: protocolLimits.maxTimeoutMs })) {
      if (!Number.isSafeInteger(ceiling) || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ceiling) throw exchangeError('AGENT_REQUEST_INVALID')
    }
    if ((limits.inputByteLimit !== null && (!Number.isSafeInteger(limits.inputByteLimit) || limits.inputByteLimit < 0)) ||
        !['AGENT_BUDGET_EXCEEDED', 'AGENT_QA_INPUT_LIMIT_EXCEEDED'].includes(limits.inputLimitError)) throw exchangeError('AGENT_REQUEST_INVALID')
    // The three frozen @1 strategies never promised strict JSON Schema.
    // A new dialect must be registered/versioned before it can be requested.
    exact(outputContract, ['mode'])
    if (!['text', 'json'].includes(outputContract.mode) ||
        (outputContract.mode === 'json' && !testMode && resolvedModel?.capabilities?.supportsStructuredOutput !== true) ||
        (request.tools.length > 0 && resolvedModel?.capabilities?.supportsToolCalling !== true)) throw exchangeError('AGENT_REQUEST_INVALID')
    const model = resolvedModel?.modelId || resolvedModel?.model_id
    if (typeof model !== 'string' || !model || /[\u0000-\u001f\u007f]/u.test(model)) throw exchangeError('AGENT_REQUEST_INVALID')
    checkedText(model, 256)
    const messages = request.messages.map(message => apiMessage(message, requestStrategy))
    const tools = request.tools.map(apiTool)
    if (new Set(request.tools.map(tool => tool.name)).size !== tools.length) throw exchangeError('AGENT_REQUEST_INVALID')
    const body = { model, messages, max_tokens: limits.maxOutputTokens,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(outputContract.mode === 'json' ? { response_format: { type: 'json_object' } } : {}),
      ...(requestStrategy === 'deepseek-openai@1' ? { thinking: { type: 'disabled' } } : {}),
      ...(requestStrategy === 'deepseek-openai@2' ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' } : {}),
      ...(requestStrategy === 'qwen-beijing@1' ? { enable_thinking: false } : {}) }
    const encoded = canonicalize(body)
    if (Buffer.byteLength(encoded, 'utf8') > limits.maxRequestBytes) throw exchangeError('AGENT_BUDGET_EXCEEDED')
    if (limits.inputByteLimit !== null) {
      const actual = Buffer.byteLength(canonicalize(tools.length ? { messages, tools } : { messages }), 'utf8')
      if (actual > limits.inputByteLimit) {
        const error = exchangeError(limits.inputLimitError)
        if (limits.inputLimitError === 'AGENT_QA_INPUT_LIMIT_EXCEEDED') error.diagnosticMetrics = { actual, limit: limits.inputByteLimit, unit: 'bytes' }
        throw error
      }
    }
    return encoded
  } catch (error) {
    if (['AGENT_REQUEST_INVALID', 'AGENT_BUDGET_EXCEEDED', 'AGENT_QA_INPUT_LIMIT_EXCEEDED'].includes(error?.code)) throw error
    throw exchangeError('AGENT_REQUEST_INVALID')
  }
}

function normalizeExchangeResponse (payload, usageReporting, requestStrategy = 'openai-compatible@1') {
  const limits = limitsForStrategy(requestStrategy)
  const choice = payload?.choices?.[0]
  const message = choice?.message
  const invalid = () => { throw outputInvalid('response_protocol', 'response') }
  if (!message || Object.getPrototypeOf(message) !== Object.prototype || !FINISH_REASONS.includes(choice.finish_reason)) invalid()
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) invalid()
  const calls = message.tool_calls || []
  if (calls.length > 16 || (choice.finish_reason === 'stop' && calls.length) ||
      (choice.finish_reason === 'tool_calls' && !calls.length)) invalid()
  const ids = new Set()
  const toolCalls = calls.map(call => {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
        Buffer.byteLength(call.id, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(call.id) ||
        typeof call.function?.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(call.function.name) ||
        typeof call.function.arguments !== 'string' || Buffer.byteLength(call.function.arguments, 'utf8') > TOOL_PAYLOAD_LIMITS.maxArgsBytes) invalid()
    let args
    try { args = JSON.parse(call.function.arguments) } catch { invalid() }
    if (!args || Object.getPrototypeOf(args) !== Object.prototype) invalid()
    ids.add(call.id)
    return { id: call.id, name: call.function.name, arguments: args, rawArguments: call.function.arguments }
  })
  const content = message.content === undefined ? null : message.content
  if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > limits.maxResponseBytes)) invalid()
  if (choice.finish_reason === 'stop' && (typeof content !== 'string' || /^\s*$/u.test(content))) invalid()
  const thinking = requestStrategy === 'deepseek-openai@2' ? message.reasoning_content : undefined
  if (thinking !== undefined && (typeof thinking !== 'string' || Buffer.byteLength(thinking, 'utf8') > limits.maxResponseBytes)) invalid()
  if (requestStrategy === 'deepseek-openai@2' && toolCalls.length && typeof thinking !== 'string') invalid()
  return { schemaVersion: EXCHANGE_VERSION, message: { role: 'assistant', content, toolCalls, ...(thinking === undefined ? {} : { thinking }) },
    finishReason: choice.finish_reason, usage: normalizeDeepSeekUsage(payload.usage, usageReporting) }
}

module.exports = { EXCHANGE_VERSION, EXCHANGE_LIMITS, limitsForStrategy, REQUEST_STRATEGIES, FINISH_REASONS, exchangeError,
  encodeExchangeRequest, normalizeExchangeResponse }
