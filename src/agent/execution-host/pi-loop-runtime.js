'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { outputInvalid } = require('../contracts/output-validation')
const { EXCHANGE_LIMITS, limitsForStrategy, encodeExchangeRequest } = require('../contracts/provider-exchange')
const { TOOL_PAYLOAD_LIMITS, deriveRecipeRequestCapacity, deriveRecipeOutboundQuota, usesModelWindowCapacity } = require('../contracts/budget-axes')
const { retryPolicy, retryDelay, MAX_OPERATION_ATTEMPTS } = require('../contracts/retry-policy')
const { assertSummaryBuffer } = require('../contracts/summary-quality')

let corePromise
function loadPiCore () {
  // The explicit streamFn is mandatory. No default provider, auth discovery,
  // steering, follow-up, model replacement or continuation hook is installed.
  if (!corePromise) corePromise = Promise.all([
    import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-ai')
  ]).then(([core, ai]) => ({ agentLoop: core.agentLoop, createStream: ai.createAssistantMessageEventStream }))
  return corePromise
}

function codedError (code, retryable = false) { return Object.assign(new Error(code), { code, retryable }) }
function abortCode (signal) {
  const code = signal?.reason?.code
  return ['AGENT_CANCELLED', 'AGENT_LEASE_LOST', 'AGENT_SCHEDULER_STOPPED', 'AGENT_BUDGET_EXCEEDED',
    'AGENT_PROVIDER_TIMEOUT', 'TOOL_TIMEOUT'].includes(code) ? code : 'AGENT_CANCELLED'
}
function checkSignal (signal) {
  if (signal?.aborted) throw codedError(abortCode(signal))
}
function notify (observer, event) {
  try { Promise.resolve(observer?.(Object.freeze(event))).catch(() => {}) } catch {}
}

async function awaitActive (operation, signal, timeoutMs, timeoutCode = 'AGENT_PROVIDER_TIMEOUT') {
  checkSignal(signal)
  let timer; let cancel
  const work = Promise.resolve().then(() => { checkSignal(signal); return operation() })
  work.catch(() => {})
  const control = new Promise((resolve, reject) => {
    cancel = () => reject(codedError(abortCode(signal)))
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => reject(codedError(timeoutCode, true)), Math.max(1, timeoutMs))
  })
  try { return await Promise.race([work, control]) } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel)
  }
}

async function waitRetry (delayMs, signal) {
  checkSignal(signal)
  let timer; let cancel
  try {
    await new Promise((resolve, reject) => {
      cancel = () => reject(codedError(abortCode(signal)))
      signal?.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(resolve, delayMs)
    })
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
  checkSignal(signal)
}

function declaration (tool) {
  const parameters = tool.parameters || { type: 'object', additionalProperties: true }
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name) ||
      !parameters || Object.getPrototypeOf(parameters) !== Object.prototype ||
      Buffer.byteLength(canonicalize(parameters), 'utf8') > 16 * 1024) throw codedError('AGENT_REQUEST_INVALID')
  if (tool.description !== undefined && (typeof tool.description !== 'string' ||
      Buffer.byteLength(tool.description, 'utf8') > 512)) throw codedError('AGENT_REQUEST_INVALID')
  return { name: tool.name, parameters, ...(tool.description === undefined ? {} : { description: tool.description }) }
}

function piMessages (context, requestStrategy) {
  const messages = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })
  for (const message of context.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: message.content })
    else if (message.role === 'assistant') messages.push({ role: 'assistant',
      content: message.content.find(part => part.type === 'text')?.text ?? null,
      toolCalls: message.content.filter(part => part.type === 'toolCall').map(part => ({ id: part.id,
        name: part.name, arguments: part.arguments, rawArguments: part.rawArguments })),
      ...(requestStrategy === 'deepseek-openai@2' && message.content.some(part => part.type === 'thinking')
        ? { thinking: message.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('') } : {}) })
    else if (message.role === 'toolResult') messages.push({ role: 'tool', toolCallId: message.toolCallId,
      content: message.content.map(part => part.text).join('') })
    else throw codedError('AGENT_REQUEST_INVALID')
  }
  return messages
}

async function runLoopExchange ({ exchange, resolvedModel, recipe, systemPrompt = '', prompt, tools = [],
  maxTurns = recipe?.maxTurns || 1, timeoutMs = 30000, signal, onProgress, beforeRequest, beforeTool,
  getRunUsage, onRequestUsage, shouldStopAfterTurn, requestCapacity, requestStrategy = 'openai-compatible@1',
  retryPolicyVersion, testMode = false, summaryStage }) {
  let policy = retryPolicy(retryPolicyVersion)
  let reservationPolicy = retryPolicyVersion !== undefined && retryPolicyVersion !== null ? policy : null
  const modelId = resolvedModel?.modelId || resolvedModel?.model_id
  if (typeof exchange !== 'function' || typeof modelId !== 'string' || !modelId ||
      !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 6 || !Array.isArray(tools) || tools.length > 16) {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  const capabilities = resolvedModel.capabilities
  if (!Number.isSafeInteger(capabilities?.maxOutputTokens) || capabilities.maxOutputTokens < 1 ||
      typeof prompt !== 'string' || /[\u0000-\u001f\u007f]/u.test(prompt) ||
      typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt, 'utf8') > 16 * 1024) throw codedError('AGENT_REQUEST_INVALID')
  const windowed = usesModelWindowCapacity(recipe?.recipeId, recipe?.recipeVersion)
  const quality = recipe?.recipeId === 'summary.minutes' && recipe?.recipeVersion === '3'
  const protocolLimits = limitsForStrategy(requestStrategy)
  if (Buffer.byteLength(prompt, 'utf8') > (windowed ? quality ? 917504 : 256 * 1024 : 16 * 1024)) throw codedError('AGENT_REQUEST_INVALID')
  if (windowed && (!requestCapacity || Object.keys(requestCapacity).sort().join(',') !== 'promptByteLimit,requestOutputTokens' ||
      !Number.isSafeInteger(requestCapacity.promptByteLimit) || requestCapacity.promptByteLimit < 0 ||
      !Number.isSafeInteger(requestCapacity.requestOutputTokens) || requestCapacity.requestOutputTokens < 1) ||
      !windowed && requestCapacity !== undefined) throw codedError('AGENT_REQUEST_INVALID')
  const windowedQuestion = windowed && recipe.recipeId === 'qa.answer'
  if (windowedQuestion || quality) {
    const expected = deriveRecipeRequestCapacity({ ...recipe, capabilities, budget: resolvedModel.budget, binding: resolvedModel, summaryStage })
    if (canonicalize(expected) !== canonicalize(requestCapacity)) throw codedError('AGENT_REQUEST_INVALID')
    const actual = Buffer.byteLength(prompt, 'utf8')
    if (actual > expected.promptByteLimit) throw Object.assign(codedError(quality ? 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED' : 'AGENT_QA_INPUT_LIMIT_EXCEEDED'),
      { diagnosticMetrics: { actual, limit: expected.promptByteLimit, unit: 'bytes' } })
  }
  const declarations = tools.map(declaration)
  if (new Set(declarations.map(tool => tool.name)).size !== tools.length) throw codedError('AGENT_REQUEST_INVALID')
  const { agentLoop, createStream } = await loadPiCore()
  checkSignal(signal)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason || codedError('AGENT_CANCELLED'))
  signal?.addEventListener('abort', abort, { once: true })
  const effectiveTimeout = Math.min(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000, quality ? 600000 : EXCHANGE_LIMITS.maxTimeoutMs)
  const deadline = performance.now() + effectiveTimeout
  let stage = 'request'
  const timer = setTimeout(() => controller.abort(codedError(stage === 'tool' ? 'TOOL_TIMEOUT' : 'AGENT_PROVIDER_TIMEOUT', stage !== 'tool')), effectiveTimeout)
  const active = () => {
    checkSignal(controller.signal)
    if (performance.now() >= deadline) throw codedError(stage === 'tool' ? 'TOOL_TIMEOUT' : 'AGENT_PROVIDER_TIMEOUT', stage !== 'tool')
  }
  const model = Object.freeze({ id: modelId, provider: resolvedModel.adapter || 'model-access', api: 'openai-completions' })
  const bindingIdentity = canonicalize(resolvedModel)
  let fatal = null; let turn = 0; let toolCalls = 0; let finalText = null; let lastRetryFailure = null; let latestMessages = []
  let usageKnown = true; let cacheKnown = true
  let inputTokens = 0; let outputTokens = 0; let cacheHitInputTokens = 0; let cacheMissInputTokens = 0
  const fail = error => { fatal ||= error; controller.abort(codedError(error?.code || 'AGENT_INTERNAL_FAILURE')) }
  const coreTools = tools.map(tool => ({ ...tool, label: tool.name, description: tool.description || tool.name,
    // Pi may coerce JSON Schema arguments. The product validates the original
    // structured arguments; Pi's envelope must not rewrite them for auditing.
    parameters: { type: 'object', additionalProperties: true },
    execute: async (_id, args) => {
      try {
        active()
        stage = 'tool'
        if (beforeTool) await awaitActive(() => beforeTool({ toolName: tool.name, args }), controller.signal, deadline - performance.now())
        active()
        const toolTimeout = Math.min(resolvedModel.budget?.toolTimeoutMs || effectiveTimeout, deadline - performance.now())
        const result = await awaitActive(() => tool.execute(args, { signal: controller.signal, timeoutMs: toolTimeout }),
          controller.signal, toolTimeout, 'TOOL_TIMEOUT')
        active()
        const content = canonicalize(result === undefined ? null : result)
        if (Buffer.byteLength(content, 'utf8') > TOOL_PAYLOAD_LIMITS.maxResultBytes) throw codedError('AGENT_BUDGET_EXCEEDED')
        toolCalls++
        stage = 'request'
        return { content: [{ type: 'text', text: content }], details: {} }
      } catch (error) {
        const failure = ['TOOL_ARGS_INVALID', 'TOOL_NOT_AVAILABLE_FOR_RECIPE'].includes(error?.code)
          ? outputInvalid('schema', 'response') : error
        fail(failure)
        throw codedError(failure?.code || 'TOOL_INTERNAL_FAILURE')
      }
    }
  }))
  const streamFn = async (requestedModel, context) => {
    latestMessages = context.messages
    const stream = createStream()
    let piMessage
    try {
      active()
      if (requestedModel !== model || canonicalize(resolvedModel) !== bindingIdentity || context.systemPrompt !== systemPrompt) throw codedError('AGENT_REQUEST_INVALID')
      if (turn >= maxTurns) throw codedError('AGENT_BUDGET_EXCEEDED')
      const maximum = !testMode && typeof beforeRequest === 'function' ? MAX_OPERATION_ATTEMPTS : 1
      let exchanged
      for (let attempt = 1; attempt <= maximum; attempt++) {
        active()
        let maxOutputTokens = capabilities.maxOutputTokens; let inputByteLimit = null
        const totals = getRunUsage ? await awaitActive(getRunUsage, controller.signal, deadline - performance.now()) : null
        if (windowed) {
          const quota = deriveRecipeOutboundQuota({ ...recipe, capabilities, budget: resolvedModel.budget, binding: resolvedModel, summaryStage,
            knownCumulativeOutputTokens: totals ? (totals.known ? totals.outputTokens : null) : (usageKnown ? outputTokens : null) })
          maxOutputTokens = quota.requestOutputTokens; inputByteLimit = quota.requestInputByteWindow
        }
        const request = { schemaVersion: 1, messages: piMessages(context, requestStrategy), tools: declarations,
          outputContract: { mode: testMode || capabilities.supportsStructuredOutput === true ? 'json' : 'text' },
          limits: { maxOutputTokens, maxRequestBytes: protocolLimits.maxRequestBytes,
            maxResponseBytes: testMode ? 64 * 1024 : protocolLimits.maxResponseBytes,
            timeoutMs: Math.max(1, Math.min(protocolLimits.maxTimeoutMs, Math.ceil(deadline - performance.now()))), inputByteLimit,
            inputLimitError: windowedQuestion && turn === 0 ? 'AGENT_QA_INPUT_LIMIT_EXCEEDED' : 'AGENT_BUDGET_EXCEEDED' } }
        const encoded = encodeExchangeRequest({ request, resolvedModel, requestStrategy, testMode })
        if (quality || requestStrategy === 'deepseek-openai@2') assertSummaryBuffer(
          Buffer.byteLength(canonicalize(request.messages), 'utf8') * 2 + Buffer.byteLength(encoded, 'utf8') * 2 + 32 * 1024 * 1024)
        if (beforeRequest) {
          let receipt
          try {
            receipt = await awaitActive(() => beforeRequest(Object.freeze({ turn: turn + 1, requestAttempt: attempt })), controller.signal, deadline - performance.now())
          } catch (error) {
            if (controller.signal.aborted || ['AGENT_CANCELLED', 'AGENT_LEASE_LOST', 'AGENT_SCHEDULER_STOPPED', 'AGENT_BUDGET_EXCEEDED'].includes(error?.code)) throw error
            throw Object.assign(codedError('AGENT_RUN_UNAVAILABLE'), { retryExhausted: true })
          }
          if (receipt?.reserved !== true || receipt.replayed === true) throw Object.assign(codedError('AGENT_RUN_UNAVAILABLE'), { retryExhausted: true })
          if (receipt.retryPolicyVersion !== undefined) {
            const confirmed = retryPolicy(receipt.retryPolicyVersion)
            if (reservationPolicy !== null && confirmed !== reservationPolicy) throw codedError('AGENT_REQUEST_INVALID')
            reservationPolicy = policy = confirmed
          }
        }
        active()
        // Reservation latency cannot extend the remaining request deadline.
        request.limits.timeoutMs = Math.max(1, Math.min(protocolLimits.maxTimeoutMs, Math.ceil(deadline - performance.now())))
        try {
          exchanged = await awaitActive(() => exchange({ request, signal: controller.signal,
            onProgress: event => { if (!controller.signal.aborted) notify(onProgress, { type: event.type, turn: turn + 1 }) } }),
          controller.signal, deadline - performance.now())
          active()
          lastRetryFailure = null
          break
        } catch (error) {
          notify(onProgress, { type: 'request_failed', turn: turn + 1 })
          usageKnown = false
          if (onRequestUsage) await awaitActive(() => onRequestUsage(null), controller.signal, deadline - performance.now())
          if (error?.retryable !== true || controller.signal.aborted) throw error
          lastRetryFailure = error
          const delayMs = retryDelay(policy, attempt, error.retryAfterMs)
          if (attempt >= maximum || delayMs >= deadline - performance.now()) {
            if (maximum === MAX_OPERATION_ATTEMPTS) error.retryExhausted = true
            throw error
          }
          notify(onProgress, { type: 'retry_wait', turn: turn + 1, requestAttempt: attempt,
            nextAttempt: attempt + 1, reason: error.code, waitMs: delayMs })
          await waitRetry(delayMs, controller.signal)
        }
      }
      const message = exchanged?.message; const calls = message?.toolCalls
      if (exchanged?.schemaVersion !== 1 || !message || !Array.isArray(calls) ||
          !['stop', 'tool_calls'].includes(exchanged.finishReason) ||
          (exchanged.finishReason === 'stop') !== (calls.length === 0)) throw outputInvalid('response_protocol', 'response')
      if (onRequestUsage) await awaitActive(() => onRequestUsage(exchanged.usage), controller.signal, deadline - performance.now())
      const usage = exchanged.usage
      if (!usage) usageKnown = false
      else if (usageKnown) {
        inputTokens += usage.inputTokens; outputTokens += usage.outputTokens
        if (usage.cacheHitInputTokens === null) cacheKnown = false
        else if (cacheKnown) { cacheHitInputTokens += usage.cacheHitInputTokens; cacheMissInputTokens += usage.cacheMissInputTokens }
      }
      turn++
      if (calls.length && (turn >= maxTurns || shouldStopAfterTurn?.({ turn, toolCalls: toolCalls + calls.length }) === true)) throw codedError('AGENT_BUDGET_EXCEEDED')
      if (calls.some(call => !tools.some(tool => tool.name === call.name))) throw outputInvalid('response_protocol', 'response')
      if (!calls.length && (typeof message.content !== 'string' || /^\s*$/u.test(message.content))) throw outputInvalid('response_protocol', 'response')
      if (!calls.length) finalText = message.content
      piMessage = { role: 'assistant', content: [
        ...(message.thinking === undefined ? [] : [{ type: 'thinking', thinking: message.thinking }]),
        ...(message.content === null ? [] : [{ type: 'text', text: message.content }]),
        ...calls.map(call => ({ type: 'toolCall', ...call }))
      ], stopReason: calls.length ? 'toolUse' : 'stop', api: model.api, provider: model.provider, model: model.id, timestamp: 0 }
      stream.push({ type: 'done', reason: piMessage.stopReason, message: piMessage })
    } catch (error) {
      fail(error)
      piMessage = { role: 'assistant', content: [], stopReason: 'error', errorMessage: error?.code || 'AGENT_INTERNAL_FAILURE', timestamp: 0 }
      stream.push({ type: 'error', reason: 'error', error: piMessage })
    }
    stream.end(piMessage)
    return stream
  }
  const context = { systemPrompt, messages: [], tools: coreTools }
  const prompts = [{ role: 'user', content: prompt, timestamp: 0 }]
  try {
    const events = agentLoop(prompts, context, { model, convertToLlm: messages => messages,
      toolExecution: 'sequential', beforeToolCall: () => {
        try { active(); return undefined } catch (error) { fail(error); return { block: true, reason: error.code, terminate: true } }
      }, shouldStopAfterTurn: () => fatal !== null || controller.signal.aborted || finalText !== null || turn >= maxTurns
    }, controller.signal, streamFn)
    await awaitActive(async () => { for await (const _event of events) {} }, controller.signal, effectiveTimeout + 20)
    if (fatal) throw fatal
    active()
    if (finalText === null) throw codedError('AGENT_BUDGET_EXCEEDED')
    if (testMode) {
      try { const value = JSON.parse(finalText); if (canonicalize(value) !== '{"ok":true}') throw new Error() } catch { throw outputInvalid('response_protocol', 'response') }
    }
    return { text: finalText, usage: usageKnown ? { inputTokens, outputTokens, usageSource: 'provider',
      cacheHitInputTokens: cacheKnown ? cacheHitInputTokens : null, cacheMissInputTokens: cacheKnown ? cacheMissInputTokens : null } : null }
  } catch (error) {
    const failure = fatal || error
    if (policy === 'agent-retry@2' && typeof beforeRequest === 'function' &&
        performance.now() >= deadline && abortCode(controller.signal) === 'AGENT_PROVIDER_TIMEOUT') {
      throw Object.assign(lastRetryFailure || failure, { retryExhausted: true })
    }
    throw failure
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort)
    controller.abort()
    for (const message of latestMessages) {
      if (typeof message.content === 'string') message.content = ''
      else if (Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === 'thinking') part.thinking = ''
        if (part.type === 'text') part.text = ''
      }
    }
    latestMessages.length = 0; prompt = ''; systemPrompt = ''; finalText = null
    prompts[0].content = ''; context.messages.length = 0; coreTools.length = 0
  }
}

module.exports = { loadPiCore, runLoopExchange, checkSignal }
