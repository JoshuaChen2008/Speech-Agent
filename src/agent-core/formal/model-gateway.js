'use strict'

const { canonicalize } = require('../canonical-json')
const { AgentCoreError } = require('../errors')
const { PiAgentAdapter } = require('../pi-agent-adapter')
const {
  canonicalBytes,
  exactObject,
  providerLimits,
  runtimeError,
  throwIfAborted
} = require('./contracts')

const IDENTITY_KEYS = Object.freeze([
  'runId', 'providerId', 'providerKind', 'model', 'recipeVersion'
])
const REQUEST_KEYS = Object.freeze([...IDENTITY_KEYS, 'operation', 'input'])
const DESCRIPTOR_KEYS = Object.freeze([
  'providerId', 'providerKind', 'model', 'maxChunkInputBytes', 'maxResultBytes', 'openModel'
])

const RECIPE_OPERATIONS = Object.freeze({
  'meeting-minutes@1': Object.freeze(['meeting-minutes.chunk', 'meeting-minutes.merge']),
  'memory-extraction@1': Object.freeze(['memory-extraction.chunk']),
  'enhanced-transcript@1': Object.freeze(['enhanced-transcript.chunk', 'enhanced-transcript.merge'])
})

const SYSTEM_PROMPTS = Object.freeze({
  'meeting-minutes.chunk': 'Generate one bounded meeting-minutes JSON object from this complete input chunk. Return JSON only with type meeting-minutes and content overview, conclusions, actionItems, risks. Every non-overview item needs evidence event-order ranges. The input has no speaker identity, so every actionItems owner must be null. Do not invent absent conclusions, action items, risks, owners, or due dates.',
  'meeting-minutes.merge': 'Merge every supplied meeting-minutes candidate into one bounded meeting-minutes JSON object. Return JSON only with type meeting-minutes and content overview, conclusions, actionItems, risks. Preserve valid evidence event-order ranges, use empty arrays for absent sections, and keep every actionItems owner null because no speaker identity is available.',
  'enhanced-transcript.chunk': 'Rewrite the complete supplied transcript chunk for readability without adding facts. Return JSON only with type enhanced-transcript and content paragraphs. Every paragraph must contain text and evidence event-order ranges, and the paragraphs together must cover every supplied eventOrder.',
  'enhanced-transcript.merge': 'Merge every supplied enhanced-transcript candidate into one bounded enhanced-transcript JSON object without adding facts. Return JSON only with type enhanced-transcript and content paragraphs. Preserve evidence event-order ranges and cover every source eventOrder represented by the candidates.',
  'memory-extraction.chunk': 'Extract only atomic structured memory candidates directly from this transcript chunk. Return JSON only with type memory-candidates and candidates. Each candidate must contain kind, semanticKey, scope, origin, content, evidence, confidenceBand, and salienceBand. Do not use summaries, invent speaker identity, or turn an automatic first-person expression into a global preference. Return an empty candidates array when nothing qualifies.'
})

function identity (value) {
  exactObject(value, IDENTITY_KEYS)
  if (typeof value.runId !== 'string' || value.runId.length < 1 || value.runId.length > 160 ||
      typeof value.providerId !== 'string' || value.providerId.length < 1 || value.providerId.length > 160 ||
      !['cloud', 'local'].includes(value.providerKind) ||
      typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 160 ||
      !Object.hasOwn(RECIPE_OPERATIONS, value.recipeVersion)) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return { ...value }
}

function sameIdentity (left, right) {
  return IDENTITY_KEYS.every((key) => left[key] === right[key])
}

function descriptor (value, expected) {
  exactObject(value, DESCRIPTOR_KEYS, 'AGENT_PROVIDER_UNAVAILABLE')
  if (value.providerId !== expected.providerId || value.providerKind !== expected.providerKind ||
      value.model !== expected.model || typeof value.openModel !== 'function') {
    throw new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
  }
  const limits = providerLimits({
    maxChunkInputBytes: value.maxChunkInputBytes,
    maxResultBytes: value.maxResultBytes
  })
  return { ...value, ...limits }
}

function structuredResult (text, maxResultBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxResultBytes) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
}

class ModelGateway {
  constructor ({ providerAdapter, agentAdapter = new PiAgentAdapter(), timeoutMs = 30000 } = {}) {
    if (!providerAdapter || typeof providerAdapter.resolve !== 'function' ||
        !agentAdapter || typeof agentAdapter.run !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.providerAdapter = providerAdapter
    this.agentAdapter = agentAdapter
    this.timeoutMs = timeoutMs
    this.bindings = new Map()
  }

  async getLimits (rawIdentity) {
    const requested = identity(rawIdentity)
    const existing = this.bindings.get(requested.runId)
    if (existing) {
      if (!sameIdentity(existing.identity, requested)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
      return { ...existing.limits }
    }
    let resolved
    try {
      resolved = descriptor(await this.providerAdapter.resolve(requested), requested)
    } catch (error) {
      throw runtimeError(error)
    }
    const limits = providerLimits({
      maxChunkInputBytes: resolved.maxChunkInputBytes,
      maxResultBytes: resolved.maxResultBytes
    })
    this.bindings.set(requested.runId, { identity: requested, descriptor: resolved, limits })
    return { ...limits }
  }

  async execute (rawRequest, signal) {
    exactObject(rawRequest, REQUEST_KEYS)
    const requestIdentity = identity(Object.fromEntries(
      IDENTITY_KEYS.map((key) => [key, rawRequest[key]])
    ))
    const binding = this.bindings.get(requestIdentity.runId)
    if (!binding || !sameIdentity(binding.identity, requestIdentity) ||
        !RECIPE_OPERATIONS[requestIdentity.recipeVersion].includes(rawRequest.operation) ||
        !rawRequest.input || typeof rawRequest.input !== 'object' || Array.isArray(rawRequest.input) ||
        canonicalBytes(rawRequest.input) > binding.limits.maxChunkInputBytes) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    throwIfAborted(signal)
    try {
      const resolvedModel = await binding.descriptor.openModel({
        operation: rawRequest.operation,
        input: structuredClone(rawRequest.input)
      })
      if (!resolvedModel || typeof resolvedModel !== 'object' ||
          !resolvedModel.model || typeof resolvedModel.streamFn !== 'function') {
        throw new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
      }
      throwIfAborted(signal)
      const result = await this.agentAdapter.run({
        resolvedModel,
        systemPrompt: SYSTEM_PROMPTS[rawRequest.operation],
        prompt: canonicalize(rawRequest.input),
        tools: [],
        maxTurns: 1,
        timeoutMs: this.timeoutMs,
        signal
      })
      throwIfAborted(signal)
      return structuredResult(result.text, binding.limits.maxResultBytes)
    } catch (error) {
      throw runtimeError(error)
    }
  }

  release (runId) {
    if (typeof runId === 'string') this.bindings.delete(runId)
  }
}

module.exports = {
  DESCRIPTOR_KEYS,
  IDENTITY_KEYS,
  ModelGateway,
  RECIPE_OPERATIONS,
  REQUEST_KEYS,
  SYSTEM_PROMPTS,
  descriptor,
  identity,
  structuredResult
}
