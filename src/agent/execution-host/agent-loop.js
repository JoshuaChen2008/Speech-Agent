'use strict'

// @ts-check

const { getRecipe } = require('../contracts/recipes')

const TOOL_ERROR_CODES = new Set([
  'TOOL_ARGS_INVALID', 'TOOL_SCOPE_DENIED', 'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'TOOL_INTERNAL_FAILURE'
])

function executionError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

async function runAdapterBounded (adapter, request, parentSignal, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timeoutHandle = null
  let removeAbortListener = null
  let rejectControl
  let controlSettled = false
  const control = new Promise((resolve, reject) => { rejectControl = reject })
  const settleControl = (error) => {
    if (controlSettled) return
    controlSettled = true
    rejectControl(error)
  }
  const cancel = () => {
    const reasonCode = parentSignal?.reason?.code === 'AGENT_BUDGET_EXCEEDED'
      ? 'AGENT_BUDGET_EXCEEDED'
      : 'AGENT_CANCELLED'
    settleControl(executionError(reasonCode))
    try { controller?.abort() } catch {}
  }
  if (parentSignal?.aborted) cancel()
  else if (parentSignal) {
    parentSignal.addEventListener('abort', cancel, { once: true })
    removeAbortListener = () => parentSignal.removeEventListener('abort', cancel)
  }
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      settleControl(executionError('AGENT_PROVIDER_TIMEOUT'))
      try { controller?.abort() } catch {}
    }, timeoutMs)
  }

  const provider = Promise.resolve().then(() => adapter.run({
    ...request,
    signal: controller?.signal || parentSignal
  }))
  // A provider may reject after cancellation or its host deadline. Keep that
  // late rejection handled even though its result is no longer observable.
  provider.catch(() => {})
  try {
    return await Promise.race([provider, control])
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    try { removeAbortListener?.() } catch {}
  }
}

function shouldStopAfterTurn ({ maxTurns, turn, toolCalls = 0, maxToolCalls = Number.MAX_SAFE_INTEGER, budgetExceeded = false } = {}) {
  return budgetExceeded === true ||
    (Number.isSafeInteger(maxToolCalls) && toolCalls >= maxToolCalls) ||
    (Number.isSafeInteger(maxTurns) && Number.isSafeInteger(turn) && turn >= maxTurns)
}

function assertPrompt (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16000 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw executionError('AGENT_REQUEST_INVALID')
  }
  return value
}

class AgentLoopExecutor {
  constructor (options = {}) {
    if (!options.adapter || typeof options.adapter.run !== 'function') {
      throw new TypeError('agent loop adapter is required')
    }
    this.adapter = options.adapter
    this.onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : () => {}
  }

  async resolveAdapter () {
    return this.adapter
  }

  async agentLoop (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw executionError('AGENT_REQUEST_INVALID')
    const allowedKeys = new Set(['recipeId', 'recipeVersion', 'prompt', 'resolvedModel', 'tools', 'signal', 'timeoutMs', 'budget', 'usageReporting', 'onProgress', 'beforeRequest'])
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw executionError('AGENT_REQUEST_INVALID')
    let recipe
    try { recipe = getRecipe(input.recipeId, input.recipeVersion) } catch { throw executionError('AGENT_REQUEST_INVALID') }
    assertPrompt(input.prompt)
    if (!input.resolvedModel || typeof input.resolvedModel !== 'object' || Array.isArray(input.resolvedModel)) {
      throw executionError('AGENT_REQUEST_INVALID')
    }
    const tools = input.tools === undefined ? [] : input.tools
    if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool !== 'object' ||
      typeof tool.name !== 'string' || typeof tool.execute !== 'function')) {
      throw executionError('AGENT_REQUEST_INVALID')
    }
    const toolNames = new Set()
    const wrappedTools = tools.map((tool) => {
      if (toolNames.has(tool.name)) throw executionError('AGENT_REQUEST_INVALID')
      toolNames.add(tool.name)
      if (!recipe.toolGrants.includes(tool.name)) throw executionError('TOOL_NOT_AVAILABLE_FOR_RECIPE')
      return {
        ...tool,
        execute: async (...args) => {
          if (input.signal?.aborted) throw executionError('AGENT_CANCELLED')
          let result
          try { result = await tool.execute(...args) } catch (error) {
            if (error?.code && TOOL_ERROR_CODES.has(error.code)) throw error
            throw error
          }
          try { this.onToolCall(Object.freeze({ toolName: tool.name })) } catch { /* observer isolation */ }
          return result
        }
      }
    })
    if (recipe.toolGrants.length === 0 && wrappedTools.length !== 0) throw executionError('TOOL_NOT_AVAILABLE_FOR_RECIPE')
    if (input.signal?.aborted) throw executionError('AGENT_CANCELLED')
    const budget = input.budget && typeof input.budget === 'object' ? input.budget : {}
    const adapter = await this.resolveAdapter()
    const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null
    if (input.beforeRequest !== undefined && typeof input.beforeRequest !== 'function') throw executionError('AGENT_REQUEST_INVALID')
    const timeoutMs = Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : Number.isSafeInteger(budget.maxWallClockMs) && budget.maxWallClockMs > 0
        ? budget.maxWallClockMs
        : null
    let result
    try {
      result = await runAdapterBounded(adapter, {
        resolvedModel: input.resolvedModel,
        recipe,
        systemPrompt: '',
        prompt: input.prompt,
        tools: wrappedTools,
        maxTurns: recipe.maxTurns,
        timeoutMs,
        onProgress: onProgress
          ? (event) => {
              if (!event || typeof event !== 'object' || Array.isArray(event) ||
                  !['request_started', 'response_received', 'request_failed'].includes(event.type) ||
                  !Number.isSafeInteger(event.turn) || event.turn < 1) return
              try { return onProgress(Object.freeze({ type: event.type, turn: event.turn })) } catch { /* progress observers do not change model work */ }
            }
          : undefined,
        beforeRequest: input.beforeRequest,
        shouldStopAfterTurn: ({ turn, toolCalls = 0, budgetExceeded = false } = {}) => shouldStopAfterTurn({
          maxTurns: recipe.maxTurns,
          turn,
          toolCalls,
          maxToolCalls: Number.isSafeInteger(budget.maxToolCalls) ? budget.maxToolCalls : Number.MAX_SAFE_INTEGER,
          budgetExceeded
        })
      }, input.signal, timeoutMs)
    } catch (error) {
      if (input.signal?.aborted && error?.code !== input.signal?.reason?.code) {
        throw executionError(input.signal?.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_CANCELLED')
      }
      throw error
    }
    // The provider may resolve after the caller has cancelled its bounded run.
    // Do not let that late result reach schema validation or persistence.
    if (input.signal?.aborted) throw executionError('AGENT_CANCELLED')
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string') {
      throw executionError('AGENT_OUTPUT_INVALID')
    }
    return {
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      maxTurns: recipe.maxTurns,
      toolGrants: [...recipe.toolGrants],
      text: result.text,
      usage: result.usage === undefined ? null : result.usage
    }
  }
}

module.exports = { AgentLoopExecutor, shouldStopAfterTurn }
