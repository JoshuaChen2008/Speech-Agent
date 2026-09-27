'use strict'

// @ts-check

const crypto = require('node:crypto')
const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { getRecipe, validateRecipeOutput } = require('../contracts/recipes')
const { deterministicRoute, isRouteFallback, routeTarget, assertTargetRecipe, validateInput } = require('./intent-router')

const TASK_ERRORS = new Set([
  'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE', 'AGENT_BUDGET_EXCEEDED'
])

function invalid (message) {
  const error = new TypeError(`AGENT_REQUEST_INVALID: ${message}`)
  error.code = 'AGENT_REQUEST_INVALID'
  return error
}

function exact (value, keys, label, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`)
  const required = [...keys]
  const expected = [...required, ...optional].sort()
  const actual = Object.keys(value).sort()
  if (actual.some((key) => !expected.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalid(`${label} has non-exact keys`)
  }
}

function outputValue (value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'result')) return value.result
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string') {
    try { return JSON.parse(value.text) } catch { return null }
  }
  return value
}

function failureCode (error) {
  if (error?.code === 'AGENT_CANCELLED') return 'AGENT_CANCELLED'
  return TASK_ERRORS.has(error?.code) ? error.code : 'AGENT_INTERNAL_FAILURE'
}

function cancelledError () {
  const error = new Error('AGENT_CANCELLED')
  error.code = 'AGENT_CANCELLED'
  return error
}

async function awaitWithCancellation (operation, signal) {
  if (signal?.aborted) throw cancelledError()
  const pending = Promise.resolve().then(() => {
    if (signal?.aborted) throw cancelledError()
    return operation()
  })
  pending.catch(() => {})
  if (!signal) return pending
  let removeAbortListener = null
  let rejectCancelled
  const cancelled = new Promise((resolve, reject) => { rejectCancelled = reject })
  const abort = () => rejectCancelled(cancelledError())
  if (signal.aborted) abort()
  else {
    signal.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', abort)
  }
  try { return await Promise.race([pending, cancelled]) } finally {
    try { removeAbortListener?.() } catch {}
  }
}

function cancelRunInBackground (runs, runId) {
  if (typeof runId !== 'string' || runId.length === 0) return
  try { Promise.resolve(runs.cancel({ runId })).catch(() => {}) } catch {}
}

function idValue (value, fallback) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value)) return value
  return fallback
}

class IntentRouteOrchestrator {
  constructor (options = {}) {
    if (!options.runs || typeof options.runs.create !== 'function' || typeof options.runs.cancel !== 'function') {
      throw new TypeError('runs.create and runs.cancel are required')
    }
    if (!options.modelAccess || typeof options.modelAccess.bind !== 'function') throw new TypeError('modelAccess.bind is required')
    if (!options.interactions || typeof options.interactions.create !== 'function' || typeof options.interactions.terminalize !== 'function') {
      throw new TypeError('interaction commands are required')
    }
    if ((!options.loop || typeof options.loop.agentLoop !== 'function') && typeof options.loopFactory !== 'function') {
      throw new TypeError('loop or loopFactory is required')
    }
    this.runs = options.runs
    this.modelAccess = options.modelAccess
    this.interactions = options.interactions
    this.loop = options.loop || null
    this.loopFactory = typeof options.loopFactory === 'function' ? options.loopFactory : null
    this.eligibility = typeof options.eligibility === 'function' ? options.eligibility : async () => 'ready'
    this.resolveModel = typeof options.resolveModel === 'function' ? options.resolveModel : async (binding) => binding
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : null
    this.allowedTargetRecipes = options.allowedTargetRecipes
      ? new Set(options.allowedTargetRecipes)
      : null
    this.inflight = new Map()
  }

  nextId (prefix, stableKey = undefined) {
    const generated = this.idFactory
      ? this.idFactory(prefix, stableKey)
      : stableKey === undefined
        ? crypto.randomUUID()
        : `${prefix}.${sha256Canonical({ prefix, stableKey }).slice(0, 48)}`
    return idValue(generated, `${prefix}.${Date.now().toString(36)}`)
  }

  async submit (input) {
    exact(input, [
      'scope', 'prompt', 'transcriptVersion', 'inputWatermark', 'inputDigest', 'clientIdempotencyKey', 'signal'
    ], 'intent submit', ['summaryUseMemory', 'requestId', 'requestGeneration', 'permittedTargetRecipes', 'onProgress'])
    if (Object.hasOwn(input, 'onProgress') && typeof input.onProgress !== 'function') throw invalid('onProgress is invalid')
    if (Object.hasOwn(input, 'summaryUseMemory') && typeof input.summaryUseMemory !== 'boolean') {
      throw invalid('summaryUseMemory is invalid')
    }
    const hasRequestId = Object.hasOwn(input, 'requestId')
    const hasRequestGeneration = Object.hasOwn(input, 'requestGeneration')
    if (hasRequestId !== hasRequestGeneration) throw invalid('request identity is incomplete')
    if (hasRequestId && (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 160 ||
        !Number.isSafeInteger(input.requestGeneration) || input.requestGeneration < 1)) throw invalid('request identity is invalid')
    let permittedTargetRecipes = null
    if (Object.hasOwn(input, 'permittedTargetRecipes')) {
      if (!Array.isArray(input.permittedTargetRecipes) || input.permittedTargetRecipes.length < 1 ||
          new Set(input.permittedTargetRecipes).size !== input.permittedTargetRecipes.length ||
          input.permittedTargetRecipes.some((recipeId) => typeof recipeId !== 'string' ||
            this.allowedTargetRecipes && !this.allowedTargetRecipes.has(recipeId))) {
        throw invalid('permitted target recipes are invalid')
      }
      for (const recipeId of input.permittedTargetRecipes) assertTargetRecipe(recipeId)
      permittedTargetRecipes = new Set(input.permittedTargetRecipes)
    }
    const routeInput = validateInput({ scope: input.scope, prompt: input.prompt })
    if (!['raw', 'refined'].includes(input.transcriptVersion)) throw invalid('transcriptVersion is invalid')
    if (!input.inputWatermark || typeof input.inputWatermark !== 'object' || Array.isArray(input.inputWatermark)) throw invalid('inputWatermark is invalid')
    if (typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputDigest)) throw invalid('inputDigest is invalid')
    if (typeof input.clientIdempotencyKey !== 'string' || input.clientIdempotencyKey.length < 1 || input.clientIdempotencyKey.length > 160) throw invalid('clientIdempotencyKey is invalid')
    const requestIdentity = {
      scope: routeInput.scope,
      prompt: routeInput.prompt,
      transcriptVersion: input.transcriptVersion,
      inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest
    }
    if (Object.hasOwn(input, 'summaryUseMemory')) requestIdentity.summaryUseMemory = input.summaryUseMemory
    if (hasRequestId) {
      requestIdentity.requestId = input.requestId
      requestIdentity.requestGeneration = input.requestGeneration
    }
    if (permittedTargetRecipes) requestIdentity.permittedTargetRecipes = [...permittedTargetRecipes].sort()
    const requestDigest = sha256Canonical(requestIdentity)
    const previous = this.inflight.get(input.clientIdempotencyKey)
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw invalid('client idempotency key was reused with a different request')
      return previous.promise
    }
    const promise = this.submitOnce({ ...input, ...routeInput }, routeInput, permittedTargetRecipes)
    this.inflight.set(input.clientIdempotencyKey, { requestDigest, promise })
    try {
      return await promise
    } finally {
      if (this.inflight.get(input.clientIdempotencyKey)?.promise === promise) this.inflight.delete(input.clientIdempotencyKey)
    }
  }

  async submitOnce (input, routeInput, permittedTargetRecipes = null) {
    const eligibility = await awaitWithCancellation(() => this.eligibility(routeInput), input.signal)
    if (input.signal?.aborted) throw cancelledError()
    if (eligibility !== 'ready') {
      return this.createTarget(input, deterministicRoute(routeInput).recipeId, 'rules', eligibility, permittedTargetRecipes)
    }
    return this.runRoute(input, permittedTargetRecipes)
  }

  async runRoute (input, permittedTargetRecipes = null) {
    if (input.signal?.aborted) throw cancelledError()
    const promptDigest = sha256Canonical(input.prompt)
    const routeRunId = this.nextId('run.route', input.clientIdempotencyKey)
    const routeInteractionId = this.nextId('interaction.route', input.clientIdempotencyKey)
    const routeRunRequest = {
      runId: routeRunId, recipeId: 'intent.route', recipeVersion: '1', scope: input.scope,
      transcriptVersion: input.transcriptVersion, inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest, requestedBy: 'user', clientIdempotencyKey: `${input.clientIdempotencyKey}:route`
    }
    if (input.requestId !== undefined) {
      routeRunRequest.requestId = input.requestId
      routeRunRequest.requestGeneration = input.requestGeneration
    }
    const routeRun = await this.runs.create(routeRunRequest)
    if (input.signal?.aborted) {
      cancelRunInBackground(this.runs, routeRun.runId)
      throw cancelledError()
    }
    let interactionCreated = false
    try {
      if (routeRun.replayed && typeof this.runs.getInteraction === 'function') {
        const existing = await awaitWithCancellation(() => this.runs.getInteraction({ interactionId: routeInteractionId }), input.signal)
        const interaction = existing?.interaction || existing
        const previousPromptDigest = interaction?.promptDigest ?? interaction?.prompt_digest
        if (previousPromptDigest !== undefined && previousPromptDigest !== promptDigest) {
          throw invalid('client idempotency key was reused with a different prompt')
        }
        if (interaction?.terminalReason === 'cancelled') {
          const cancelled = new Error('AGENT_CANCELLED')
          cancelled.code = 'AGENT_CANCELLED'
          throw cancelled
        }
        if (interaction?.terminalReason === 'succeeded') {
          const selected = routeTarget(interaction.result)
          if (selected) return this.createTarget(input, selected, 'model', 'ready', permittedTargetRecipes)
        }
        if (interaction?.terminalReason === 'failed') {
          return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready', permittedTargetRecipes)
        }
        if (interaction?.terminalReason === undefined || interaction?.terminalReason === null) {
          const terminalized = await this.interactions.terminalize({
            interactionId: routeInteractionId, terminalReason: 'failed', errorCode: 'AGENT_WORKER_EXITED',
            result: null, usage: null, durationMs: 0
          }).catch(() => null)
          const terminalReason = terminalized?.terminalReason ?? terminalized?.terminal_reason
          if (terminalReason !== 'failed') {
            const blocked = new Error('route recovery could not be terminalized')
            blocked.code = 'AGENT_RECOVERY_BLOCKED'
            throw blocked
          }
          return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready', permittedTargetRecipes)
        }
      }
      if (routeRun.replayed) {
        const cancelled = await awaitWithCancellation(() => this.runs.cancel({ runId: routeRun.runId }), input.signal).catch(() => null)
        if (input.signal?.aborted) throw cancelledError()
        if (!cancelled || !['cancelled', 'failed'].includes(cancelled.state)) {
          const blocked = new Error('route recovery could not be cancelled')
          blocked.code = 'AGENT_RECOVERY_BLOCKED'
          throw blocked
        }
        return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready', permittedTargetRecipes)
      }
      const binding = await awaitWithCancellation(() => this.modelAccess.bind({ runId: routeRun.runId, recipeId: 'intent.route', recipeVersion: '1', executionForm: 'agent_loop' }), input.signal)
      if (input.signal?.aborted) throw cancelledError()
      await awaitWithCancellation(() => this.interactions.create({ runId: routeRun.runId, interactionId: routeInteractionId, routingMode: 'model', promptDigest }), input.signal)
      interactionCreated = true
      if (input.signal?.aborted) throw cancelledError()
      const resolvedModel = await awaitWithCancellation(() => this.resolveModel(binding), input.signal)
      const loop = this.loopFactory ? await awaitWithCancellation(() => this.loopFactory(binding), input.signal) : this.loop
      if (!loop || typeof loop.agentLoop !== 'function') throw invalid('route loop is unavailable')
      const result = await awaitWithCancellation(() => loop.agentLoop({
        recipeId: 'intent.route', recipeVersion: '1', prompt: input.prompt,
        resolvedModel, signal: input.signal, budget: binding?.budget,
        usageReporting: binding?.capabilities?.usageReporting !== false,
        onProgress: typeof input.onProgress === 'function'
          ? (event) => input.onProgress(Object.freeze({ type: event.type, runId: routeRun.runId }))
          : undefined
      }), input.signal)
      if (input.signal?.aborted) throw cancelledError()
      const output = outputValue(result)
      let targetRecipe = null
      try {
        validateRecipeOutput('intent.route', '1', output)
        targetRecipe = routeTarget(output)
      } catch {
        targetRecipe = null
      }
      if (!targetRecipe) {
        await this.interactions.terminalize({
          interactionId: routeInteractionId, terminalReason: 'failed', errorCode: 'AGENT_OUTPUT_INVALID',
          result: null, usage: null, durationMs: 0
        })
        return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready', permittedTargetRecipes)
      }
      await this.interactions.terminalize({
        interactionId: routeInteractionId, terminalReason: 'succeeded', errorCode: null,
        result: output, usage: result?.usage ?? null, durationMs: Number.isSafeInteger(result?.durationMs) ? result.durationMs : 0
      })
      return this.createTarget(input, targetRecipe, 'model', 'ready', permittedTargetRecipes)
    } catch (error) {
      if (error?.code === 'AGENT_RECOVERY_BLOCKED') throw error
      const code = input.signal?.aborted ? 'AGENT_CANCELLED' : failureCode(error)
      if (interactionCreated) {
        await this.interactions.terminalize({
          interactionId: routeInteractionId,
          terminalReason: code === 'AGENT_CANCELLED' ? 'cancelled' : 'failed',
          errorCode: code === 'AGENT_CANCELLED' ? null : code,
          result: null, usage: null, durationMs: 0
        }).catch(() => {})
      }
      if (code === 'AGENT_CANCELLED') {
        cancelRunInBackground(this.runs, routeRun.runId)
        const cancelled = new Error('AGENT_CANCELLED')
        cancelled.code = 'AGENT_CANCELLED'
        throw cancelled
      }
      if (isRouteFallback({ eligibility: 'ready', error: Object.assign(error, { code }), result: null })) {
        return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready', permittedTargetRecipes)
      }
      throw error
    }
  }

  async submitFixedTarget (input) {
    exact(input, [
      'scope', 'prompt', 'transcriptVersion', 'inputWatermark', 'inputDigest',
      'clientIdempotencyKey', 'signal', 'requestId', 'requestGeneration', 'summaryUseMemory'
    ], 'fixed target submit')
    if (input.scope?.kind !== 'session' || typeof input.summaryUseMemory !== 'boolean' ||
        !Number.isSafeInteger(input.requestGeneration) || input.requestGeneration < 1 ||
        typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 160) {
      throw invalid('fixed summary identity or policy is invalid')
    }
    if (this.allowedTargetRecipes && !this.allowedTargetRecipes.has('summary.minutes')) {
      return { runId: null, interactionId: null, recipeId: 'summary.minutes', routingMode: 'preset', eligibility: 'ready', unsupported: true }
    }
    const routeInput = validateInput({ scope: input.scope, prompt: input.prompt })
    if (!['raw', 'refined'].includes(input.transcriptVersion) ||
        !input.inputWatermark || typeof input.inputWatermark !== 'object' || Array.isArray(input.inputWatermark) ||
        typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputDigest) ||
        typeof input.clientIdempotencyKey !== 'string' || input.clientIdempotencyKey.length < 1 || input.clientIdempotencyKey.length > 160) {
      throw invalid('fixed summary input identity is invalid')
    }
    return this.createTarget({ ...input, ...routeInput }, 'summary.minutes', 'preset', 'ready', new Set(['summary.minutes']))
  }

  async createTarget (input, recipeId, routingMode, eligibility = 'ready', permittedTargetRecipes = null) {
    if (input.signal?.aborted) throw cancelledError()
    assertTargetRecipe(recipeId)
    if (eligibility !== 'ready') return { runId: null, interactionId: null, recipeId, routingMode, eligibility }
    const targetSet = permittedTargetRecipes || this.allowedTargetRecipes
    if (targetSet && !targetSet.has(recipeId)) {
      if (permittedTargetRecipes?.has('qa.answer')) recipeId = 'qa.answer'
      else {
        return { runId: null, interactionId: null, recipeId, routingMode, eligibility: 'ready', unsupported: true }
      }
    }
    const runId = this.nextId('run.target', input.clientIdempotencyKey)
    const interactionId = this.nextId('interaction.target', input.clientIdempotencyKey)
    const runRequest = {
      runId, recipeId, recipeVersion: '1', scope: input.scope,
      transcriptVersion: input.transcriptVersion, inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest, requestedBy: 'user', clientIdempotencyKey: input.clientIdempotencyKey
    }
    if (input.requestId !== undefined) {
      runRequest.requestId = input.requestId
      runRequest.requestGeneration = input.requestGeneration
    }
    if (recipeId === 'summary.minutes' && Object.hasOwn(input, 'summaryUseMemory')) {
      runRequest.summaryUseMemory = input.summaryUseMemory
    }
    const run = await this.runs.create(runRequest)
    try {
      if (input.signal?.aborted) throw cancelledError()
      if (run.replayed && typeof this.runs.getInteraction === 'function') {
        const existing = await awaitWithCancellation(() => this.runs.getInteraction({ interactionId }), input.signal)
        const interaction = existing?.interaction || existing
        const previousPromptDigest = interaction?.promptDigest ?? interaction?.prompt_digest
        if (previousPromptDigest !== undefined && previousPromptDigest !== sha256Canonical(input.prompt)) {
          throw invalid('client idempotency key was reused with a different prompt')
        }
      }
      const binding = await awaitWithCancellation(() => this.modelAccess.bind({ runId: run.runId, recipeId, recipeVersion: '1', executionForm: 'agent_loop' }), input.signal)
      if (input.signal?.aborted) throw cancelledError()
      await awaitWithCancellation(() => this.interactions.create({ runId: run.runId, interactionId, routingMode, promptDigest: sha256Canonical(input.prompt) }), input.signal)
      if (input.signal?.aborted) throw cancelledError()
      return {
        runId: run.runId,
        interactionId,
        recipeId,
        routingMode,
        eligibility: 'ready',
        state: run.state,
        replayed: run.replayed === true,
        binding
      }
    } catch (error) {
      if (input.signal?.aborted || error?.code === 'AGENT_CANCELLED') cancelRunInBackground(this.runs, run.runId)
      throw error
    }
  }

  async reselect (input) {
    exact(input, [
      'currentRunId', 'recipeId', 'scope', 'prompt', 'transcriptVersion',
      'inputWatermark', 'inputDigest', 'clientIdempotencyKey', 'signal'
    ], 'intent reselect', ['summaryUseMemory'])
    if (Object.hasOwn(input, 'summaryUseMemory') && typeof input.summaryUseMemory !== 'boolean') throw invalid('summaryUseMemory is invalid')
    assertTargetRecipe(input.recipeId)
    await this.runs.cancel({ runId: input.currentRunId })
    const eligibility = await this.eligibility({ scope: input.scope, prompt: input.prompt })
    return this.createTarget(input, input.recipeId, 'model', eligibility)
  }
}

module.exports = { IntentRouteOrchestrator, TASK_ERRORS }
