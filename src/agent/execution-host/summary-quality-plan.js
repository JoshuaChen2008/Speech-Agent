'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { deriveRecipeRequestCapacity } = require('../contracts/budget-axes')
const { limitsForStrategy } = require('../contracts/provider-exchange')
const { planInputAsync, assertPlanCoverage } = require('./summary-input-plan')
const { POLICY, STAGES, CANDIDATES } = require('../contracts/summary-quality')
const ENVELOPE = 16384

function capacity (binding, summaryStage) {
  return deriveRecipeRequestCapacity({ recipeId: 'summary.minutes', recipeVersion: '3', capabilities: binding.capabilities, budget: binding.budget, binding, summaryStage })
}
function fail (actual, limit) {
  throw Object.assign(new Error('AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'), { code: 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', diagnosticMetrics: { actual, limit: Math.max(0, limit), unit: 'bytes' } })
}
async function planSummaryQuality (input, userPrompt, binding, signal) {
  const protocol = limitsForStrategy(binding.requestStrategy)
  const capacities = Object.fromEntries(STAGES.map(stage => [stage, capacity(binding, stage)]))
  // The worst later stage reserves the full preceding result, including JSON
  // escaping. The final HTTP envelope and every real outbound are checked too.
  const requestLimit = Math.min(...Object.values(capacities).map(value => value.promptByteLimit), protocol.maxRequestBytes - ENVELOPE)
  const responseReserve = binding.requestStrategy === 'deepseek-openai@2' ? Math.max(...Object.values(capacities).map(value => value.requestOutputTokens)) * 16 : 0
  let lastLimit = 0
  for (const mode of ['whole', 'chunked']) {
    for (const [intermediateBytes, finalBytes] of CANDIDATES) {
      if (signal?.aborted) throw Object.assign(new Error('AGENT_CANCELLED'), { code: 'AGENT_CANCELLED' })
      const precedingBytes = mode === 'whole' ? finalBytes : intermediateBytes
      const promptLimit = requestLimit - 2 * precedingBytes - 4096
      lastLimit = promptLimit
      const fanIn = Math.min(4, Math.floor((requestLimit - 2 * finalBytes - 4096) / (2 * intermediateBytes)))
      if (promptLimit < 2048 || 2 * finalBytes + responseReserve + ENVELOPE > protocol.maxResponseBytes || mode === 'chunked' && fanIn < 2) continue
      const policy = { policyVersion: POLICY, key: 'summaryPlan', version: 3, promptLimit, countOnlyExecutedNodes: true,
        fanIn: mode === 'whole' ? 4 : fanIn,
        instruction: '完整读取本块原文，保留同一议题的后续追问、反驳、否定、修订与来源；阶段由宿主固定。' }
      let plan
      try { plan = await planInputAsync(input, userPrompt, binding, signal, policy) } catch (error) {
        if (error.code === 'AGENT_CANCELLED' || error.code === 'AGENT_REQUEST_INVALID' || error.code === 'AGENT_INPUT_EMPTY') throw error
        if (error.code !== 'AGENT_BUDGET_EXCEEDED') throw error
        continue
      }
      if (mode === 'whole' && plan.leaves.length !== 1 || mode === 'chunked' && plan.leaves.length === 1) {
        for (const leaf of plan.leaves) leaf.prompt = ''
        continue
      }
      assertPlanCoverage(input, plan, policy)
      const quality = { policyVersion: POLICY, mode, intermediateBytes, finalBytes, requestLimit,
        stageOutputTokens: Object.fromEntries(STAGES.map(stage => [stage, capacities[stage].requestOutputTokens])),
        loopLimit: plan.nodeCount * 3, requestLimitCount: plan.nodeCount * 9 }
      plan.planDigest = sha256Canonical({ prior: plan.planDigest, quality })
      return { ...plan, promptLimit: requestLimit, quality }
    }
  }
  fail(Buffer.byteLength(canonicalize(input.events), 'utf8'), lastLimit)
}
module.exports = { POLICY, STAGES, CANDIDATES, capacity, planSummaryQuality }
