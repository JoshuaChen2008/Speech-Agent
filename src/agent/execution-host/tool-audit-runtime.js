'use strict'

const { getRecipe } = require('../contracts/recipes')
const {
  TOOL_ERROR_CODES,
  assertRecipeToolAuthorization,
  deriveToolResultMetadata
} = require('../contracts/controlled-tools')
const { assertBudgetSnapshot, evaluateBudgetAxes } = require('../contracts/budget-axes')

function toolError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function identifier (value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function knownToolError (error) {
  return TOOL_ERROR_CODES.includes(error?.code) ? error.code : 'TOOL_INTERNAL_FAILURE'
}

class ToolAuditRuntime {
  constructor (options = {}) {
    identifier(options.interactionId, 'interactionId')
    if (!Number.isSafeInteger(options.attempt) || options.attempt < 1) throw new TypeError('attempt is invalid')
    if (!options.interactions || typeof options.interactions.startToolCall !== 'function' ||
        typeof options.interactions.finishToolCall !== 'function') {
      throw new TypeError('tool audit interaction adapter is required')
    }
    if (!Array.isArray(options.tools)) throw new TypeError('tools are required')
    this.recipe = getRecipe(options.recipeId, options.recipeVersion)
    this.interactionId = options.interactionId
    this.attempt = options.attempt
    this.interactions = options.interactions
    this.budget = assertBudgetSnapshot(options.budget)
    this.toolsByName = new Map()
    for (const tool of options.tools) {
      if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || typeof tool.execute !== 'function' || this.toolsByName.has(tool.name)) {
        throw new TypeError('tools are invalid')
      }
      assertRecipeToolAuthorization(this.recipe.recipeId, this.recipe.recipeVersion, tool.name)
      this.toolsByName.set(tool.name, tool)
    }
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.scheduleTimeout = typeof options.scheduleTimeout === 'function'
      ? options.scheduleTimeout
      : (callback, delayMs) => setTimeout(callback, delayMs)
    this.cancelTimeout = typeof options.cancelTimeout === 'function'
      ? options.cancelTimeout
      : (timer) => clearTimeout(timer)
    this.signal = options.signal || null
    this.startedAt = this.now()
    this.callOrder = 0
    this.activeToolCalls = 0
    this.resultBytes = 0
    this.sourceTextBytes = 0
  }

  offset () {
    const value = this.now() - this.startedAt
    if (!Number.isSafeInteger(value) || value < 0) throw toolError('TOOL_INTERNAL_FAILURE')
    return value
  }

  budgetExceeded (toolCallCount, activeToolCalls, activeToolElapsedMs) {
    return evaluateBudgetAxes(this.budget, {
      turnCount: 0,
      requestInputTokens: 0,
      cumulativeBilledInputTokens: null,
      cumulativeBilledOutputTokens: null,
      wallClockMs: this.offset(),
      toolCallCount,
      activeToolCalls,
      activeToolElapsedMs,
      cumulativeToolResultBytes: this.resultBytes,
      cumulativeSourceTextBytes: this.sourceTextBytes
    })
  }

  tools () {
    return this.recipe.toolGrants.map((name) => {
      const tool = this.toolsByName.get(name)
      if (!tool) throw new TypeError('a registered tool implementation is required')
      return { name, execute: (args) => this.execute(tool, args) }
    })
  }

  async executeWithinTimeout (tool, args) {
    let timer = null
    let removeAbortListener = null
    let timeoutReject
    const timeout = new Promise((_, reject) => {
      timeoutReject = reject
      timer = this.scheduleTimeout(() => timeoutReject(toolError('TOOL_TIMEOUT')), this.budget.toolTimeoutMs)
    })
    const cancellation = this.signal
      ? new Promise((_, reject) => {
        if (this.signal.aborted) {
          reject(toolError('TOOL_CANCELLED'))
          return
        }
        const onAbort = () => reject(toolError('TOOL_CANCELLED'))
        this.signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => this.signal.removeEventListener('abort', onAbort)
      })
      : null
    try {
      const operations = [
        Promise.resolve().then(() => tool.execute(args)),
        timeout
      ]
      if (cancellation) operations.push(cancellation)
      return await Promise.race(operations)
    } finally {
      this.cancelTimeout(timer)
      if (removeAbortListener) removeAbortListener()
    }
  }

  async execute (tool, args) {
    const callOrder = ++this.callOrder
    const startedOffsetMs = this.offset()
    const callId = `tool.${this.interactionId}.${this.attempt}.${callOrder}`
    this.activeToolCalls += 1
    try {
      const before = this.budgetExceeded(callOrder, this.activeToolCalls, 0)
      await this.interactions.startToolCall({
        callId, interactionId: this.interactionId, attempt: this.attempt, callOrder,
        toolName: tool.name, startedOffsetMs, args
      })
      if (before.exhausted) {
        await this.finishFailure(callId, startedOffsetMs, 'TOOL_BUDGET_EXCEEDED')
        throw toolError('TOOL_BUDGET_EXCEEDED')
      }
      const result = await this.executeWithinTimeout(tool, args)
      const metadata = deriveToolResultMetadata(tool.name, args, result)
      this.resultBytes += metadata.resultBytes
      this.sourceTextBytes += metadata.sourceTextBytes
      const after = this.budgetExceeded(callOrder, this.activeToolCalls, this.offset() - startedOffsetMs)
      if (after.exhausted) {
        this.resultBytes -= metadata.resultBytes
        this.sourceTextBytes -= metadata.sourceTextBytes
        await this.finishFailure(callId, startedOffsetMs, 'TOOL_BUDGET_EXCEEDED')
        throw toolError('TOOL_BUDGET_EXCEEDED')
      }
      await this.interactions.finishToolCall({
        callId, status: 'succeeded', result, errorCode: null, endedOffsetMs: this.offset(),
        sourceRefs: [...metadata.sourceRefs],
        counts: {
          resultBytes: metadata.resultBytes,
          sourceTextBytes: metadata.sourceTextBytes,
          sourceReferenceCount: metadata.sourceReferenceCount
        }
      })
      return result
    } catch (error) {
      const code = knownToolError(error)
      if (code !== 'TOOL_BUDGET_EXCEEDED') await this.finishFailure(callId, startedOffsetMs, code)
      if (error?.code === code) throw error
      throw toolError(code)
    } finally {
      this.activeToolCalls -= 1
    }
  }

  async finishFailure (callId, startedOffsetMs, errorCode) {
    await this.interactions.finishToolCall({
      callId,
      status: errorCode === 'TOOL_CANCELLED' ? 'cancelled' : 'failed',
      result: null,
      errorCode,
      endedOffsetMs: Math.max(startedOffsetMs, this.offset()),
      sourceRefs: [],
      counts: { resultBytes: 0, sourceTextBytes: 0, sourceReferenceCount: 0 }
    })
  }
}

function createToolAuditRuntime (options) {
  return new ToolAuditRuntime(options)
}

module.exports = Object.freeze({ ToolAuditRuntime, createToolAuditRuntime })
