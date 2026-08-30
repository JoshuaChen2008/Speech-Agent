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

function exact (value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
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
    if (!options.loop || typeof options.loop.agentLoop !== 'function') throw new TypeError('loop.agentLoop is required')
    this.runs = options.runs
    this.modelAccess = options.modelAccess
    this.interactions = options.interactions
    this.loop = options.loop
    this.eligibility = typeof options.eligibility === 'function' ? options.eligibility : async () => 'ready'
    this.resolveModel = typeof options.resolveModel === 'function' ? options.resolveModel : async (binding) => binding
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID()
  }

  nextId (prefix) {
    return idValue(this.idFactory(), `${prefix}.${Date.now().toString(36)}`)
  }

  async submit (input) {
    exact(input, [
      'scope', 'prompt', 'transcriptVersion', 'inputWatermark', 'inputDigest', 'clientIdempotencyKey', 'signal'
    ], 'intent submit')
    const routeInput = validateInput({ scope: input.scope, prompt: input.prompt })
    if (!['raw', 'refined'].includes(input.transcriptVersion)) throw invalid('transcriptVersion is invalid')
    if (!input.inputWatermark || typeof input.inputWatermark !== 'object' || Array.isArray(input.inputWatermark)) throw invalid('inputWatermark is invalid')
    if (typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputDigest)) throw invalid('inputDigest is invalid')
    if (typeof input.clientIdempotencyKey !== 'string' || input.clientIdempotencyKey.length < 1 || input.clientIdempotencyKey.length > 160) throw invalid('clientIdempotencyKey is invalid')
    const eligibility = await this.eligibility(routeInput)
    if (eligibility !== 'ready') {
      return this.createTarget({ ...input, ...routeInput }, deterministicRoute(routeInput).recipeId, 'rules', eligibility)
    }
    return this.runRoute({ ...input, ...routeInput })
  }

  async runRoute (input) {
    const promptDigest = sha256Canonical(input.prompt)
    const routeRunId = this.nextId('run.route')
    const routeInteractionId = this.nextId('interaction.route')
    const routeRun = await this.runs.create({
      runId: routeRunId, recipeId: 'intent.route', recipeVersion: '1', scope: input.scope,
      transcriptVersion: input.transcriptVersion, inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest, requestedBy: 'user', clientIdempotencyKey: `${input.clientIdempotencyKey}:route`
    })
    let interactionCreated = false
    try {
      const binding = await this.modelAccess.bind({ runId: routeRun.runId, recipeId: 'intent.route', recipeVersion: '1', executionForm: 'agent_loop' })
      await this.interactions.create({ runId: routeRun.runId, interactionId: routeInteractionId, routingMode: 'model', promptDigest })
      interactionCreated = true
      const resolvedModel = await this.resolveModel(binding)
      const result = await this.loop.agentLoop({
        recipeId: 'intent.route', recipeVersion: '1', prompt: input.prompt,
        resolvedModel, signal: input.signal, usageReporting: binding?.capabilities?.usageReporting !== false
      })
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
        return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready')
      }
      await this.interactions.terminalize({
        interactionId: routeInteractionId, terminalReason: 'succeeded', errorCode: null,
        result: output, usage: result?.usage ?? null, durationMs: Number.isSafeInteger(result?.durationMs) ? result.durationMs : 0
      })
      return this.createTarget(input, targetRecipe, 'model', 'ready')
    } catch (error) {
      const code = failureCode(error)
      if (interactionCreated) {
        await this.interactions.terminalize({
          interactionId: routeInteractionId,
          terminalReason: code === 'AGENT_CANCELLED' ? 'cancelled' : 'failed',
          errorCode: code === 'AGENT_CANCELLED' ? null : code,
          result: null, usage: null, durationMs: 0
        }).catch(() => {})
      }
      if (code === 'AGENT_CANCELLED') {
        await this.runs.cancel({ runId: routeRun.runId }).catch(() => {})
        const cancelled = new Error('AGENT_CANCELLED')
        cancelled.code = 'AGENT_CANCELLED'
        throw cancelled
      }
      if (isRouteFallback({ eligibility: 'ready', error: Object.assign(error, { code }), result: null })) {
        return this.createTarget(input, deterministicRoute({ scope: input.scope, prompt: input.prompt }).recipeId, 'rules', 'ready')
      }
      throw error
    }
  }

  async createTarget (input, recipeId, routingMode, eligibility = 'ready') {
    assertTargetRecipe(recipeId)
    if (eligibility !== 'ready') return { runId: null, interactionId: null, recipeId, routingMode, eligibility }
    const runId = this.nextId('run.target')
    const interactionId = this.nextId('interaction.target')
    const run = await this.runs.create({
      runId, recipeId, recipeVersion: '1', scope: input.scope,
      transcriptVersion: input.transcriptVersion, inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest, requestedBy: 'user', clientIdempotencyKey: input.clientIdempotencyKey
    })
    const binding = await this.modelAccess.bind({ runId: run.runId, recipeId, recipeVersion: '1', executionForm: 'agent_loop' })
    await this.interactions.create({ runId: run.runId, interactionId, routingMode, promptDigest: sha256Canonical(input.prompt) })
    return { runId: run.runId, interactionId, recipeId, routingMode, eligibility: 'ready', binding }
  }

  async reselect (input) {
    exact(input, [
      'currentRunId', 'recipeId', 'scope', 'prompt', 'transcriptVersion',
      'inputWatermark', 'inputDigest', 'clientIdempotencyKey', 'signal'
    ], 'intent reselect')
    assertTargetRecipe(input.recipeId)
    await this.runs.cancel({ runId: input.currentRunId })
    const eligibility = await this.eligibility({ scope: input.scope, prompt: input.prompt })
    return this.createTarget(input, input.recipeId, 'model', eligibility)
  }
}

module.exports = { IntentRouteOrchestrator, TASK_ERRORS }
