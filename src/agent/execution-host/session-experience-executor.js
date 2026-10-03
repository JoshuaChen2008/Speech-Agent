'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { deriveRecipeRequestCapacity } = require('../contracts/budget-axes')
const { validateRecipeOutput } = require('../contracts/recipes')
const { readFrozenSummaryInput } = require('./summary-input-source')
const { planExperienceInputAsync } = require('./summary-input-plan')

function fail (code) { const error = new Error(code); error.code = code; throw error }

async function executeSessionExperiences ({ personalContext, storage, loop, binding, resolvedModel, job }) {
  const identity = job.attemptIdentity
  const started = performance.now()
  const remaining = () => typeof job.getRemainingWallClockMs === 'function' ? job.getRemainingWallClockMs()
    : Math.max(0, (job.remainingWallClockMs ?? binding.budget.maxWallClockMs) - Math.floor(performance.now() - started))
  const checkActive = () => {
    if (job.signal?.aborted) fail(job.signal.reason?.code || 'AGENT_CANCELLED')
    if (remaining() <= 0) fail('AGENT_BUDGET_EXCEEDED')
  }
  checkActive()
  const input = await readFrozenSummaryInput(personalContext, job.source, job.signal)
  input.confirmedMemories = (await personalContext.sessionExperiences({ action: 'memories', attemptIdentity: identity }, job.signal)).confirmedMemories
  const plan = await planExperienceInputAsync(input, binding, job.signal)
  const requestCapacity = deriveRecipeRequestCapacity({ recipeId: 'context.ingest.session', recipeVersion: '3', capabilities: binding.capabilities, budget: binding.budget })
  try {
    const { planDigest, inputDigest, bindingDigest, nodeCount, segmentCount, rawTextBytes, canonicalBytes } = plan
    await storage.summaryInputPlan({ action: 'register', attemptIdentity: identity,
      plan: { planDigest, inputDigest, bindingDigest, nodeCount, segmentCount, rawTextBytes, canonicalBytes, leafCount: plan.leaves.length } })
    let receipt = await personalContext.sessionExperiences({ action: 'status', attemptIdentity: identity }, job.signal)
    let sequence = Number.isSafeInteger(job.requestCount) ? job.requestCount : 0
    for (let ordinal = receipt.completedRanges; ordinal < plan.leaves.length; ordinal += 1) {
      checkActive()
      const prompt = plan.leaves[ordinal].prompt
      const result = await loop.agentLoop({ recipeId: 'context.ingest.session', recipeVersion: '3', prompt, resolvedModel,
        signal: job.signal, budget: binding.budget, requestCapacity,
        timeoutMs: Math.min(180000, remaining()),
        usageReporting: binding.capabilities.usageReporting !== false,
        beforeRequest: async ({ turn } = {}) => {
          checkActive()
          await storage.reserveFormalAgentModelRequest({ attemptIdentity: identity, requestSequence: ++sequence,
            operationDigest: sha256Canonical({ planDigest, ordinal, promptDigest: sha256Canonical(prompt), turn: turn || 1 }) }, job.signal)
        },
        getRunUsage: () => storage.summaryInputPlan({ action: 'read', attemptIdentity: identity }),
        onRequestUsage: usage => storage.summaryInputPlan({ action: 'receipt', attemptIdentity: identity, requestSequence: sequence, usage })
      })
      checkActive()
      let output
      try { output = result.output || JSON.parse(result.text); validateRecipeOutput('context.ingest.session', '3', output) } catch { fail('AGENT_OUTPUT_INVALID') }
      if (output.stage !== 'range') fail('AGENT_OUTPUT_INVALID')
      const parts = JSON.parse(prompt).experienceRange.parts.map(({ text, ...part }) => part)
      receipt = await personalContext.sessionExperiences({ action: 'commit', attemptIdentity: identity, ordinal, planDigest, parts, output }, job.signal)
      plan.leaves[ordinal].prompt = ''
      await new Promise(resolve => setImmediate(resolve))
    }
    checkActive()
    await readFrozenSummaryInput(personalContext, job.source, job.signal, { collect: false })
    await personalContext.sessionExperiences({ action: 'memories', attemptIdentity: identity }, job.signal)
    const { replayed, ...output } = receipt
    validateRecipeOutput('context.ingest.session', '3', output)
    const totals = await storage.summaryInputPlan({ action: 'read', attemptIdentity: identity })
    return { text: canonicalize(output), usage: totals.known ? { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
      usageSource: 'provider', cacheHitInputTokens: totals.cacheHitInputTokens ?? null, cacheMissInputTokens: totals.cacheMissInputTokens ?? null } : null }
  } finally {
    input.events.length = 0
    for (const leaf of plan.leaves) leaf.prompt = ''
  }
}

module.exports = { executeSessionExperiences }
