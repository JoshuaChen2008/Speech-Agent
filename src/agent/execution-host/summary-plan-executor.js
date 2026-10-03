'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { validateRecipeOutput } = require('../contracts/recipes')
const { INTERMEDIATE_LIMIT } = require('./summary-input-plan')

function fail (code) { const error = new Error(code); error.code = code; throw error }
function checkReferences (value, input, from, through) {
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, 'fromEventOrder')) {
    if (value.sessionId !== input.sessionId || value.transcriptVersion !== 'raw' ||
        value.fromEventOrder < from || value.throughEventOrder > through) fail('AGENT_OUTPUT_INVALID')
  }
  for (const child of Object.values(value)) checkReferences(child, input, from, through)
}

async function executeInputPlan ({ input, plan, invoke, signal, onProgress, validateReferences }) {
  const question = plan.policyVersion === 'qa-long-input@1'
  if (!question && plan.policyVersion !== 'summary-long-input@1') fail('AGENT_REQUEST_INVALID')
  let nodes = []
  let validated = 0
  const execute = async (prompt, from, through, intermediate) => {
    if (signal?.aborted) fail('AGENT_CANCELLED')
    if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > plan.promptLimit) fail('AGENT_BUDGET_EXCEEDED')
    const result = await invoke(prompt)
    if (signal?.aborted) fail('AGENT_CANCELLED')
    let output
    try { output = JSON.parse(result.text); validateRecipeOutput(question ? 'qa.answer' : 'summary.minutes', question ? '3' : '2', output) } catch { fail('AGENT_OUTPUT_INVALID') }
    checkReferences(output, input, from, through)
    if (typeof validateReferences === 'function') validateReferences(output)
    if (intermediate && Buffer.byteLength(canonicalize(output), 'utf8') > INTERMEDIATE_LIMIT) fail('AGENT_OUTPUT_INVALID')
    return { fromEventOrder: from, throughEventOrder: through, output }
  }
  try {
    for (const leaf of plan.leaves) {
      nodes.push(await execute(leaf.prompt, leaf.fromEventOrder, leaf.throughEventOrder, plan.leaves.length > 1))
      leaf.prompt = ''
      validated += 1
      await onProgress({ phase: 'validating', activity: true, validatedChunkCount: validated, totalChunkCount: plan.leaves.length })
      await new Promise(resolve => setImmediate(resolve))
    }
    for (const groups of plan.levels) {
      const next = []
      let index = 0
      for (const size of groups) {
        const parts = nodes.slice(index, index + size)
        if (size === 1) { next.push(parts[0]); nodes[index] = null; index += 1; continue }
        const from = parts[0].fromEventOrder
        const through = parts.at(-1).throughEventOrder
        const prompt = canonicalize({
          userPrompt: plan.userPrompt,
          instruction: question
            ? '围绕userPrompt按连续来源顺序归并回答，只用提供的证据；后文撤销或修订优先于早先决定，保留否定、sourceRefs、memoryRefs及仍待确认的unresolved。不得把各块的证据不足误判为整场无答案，不得新增引用。返回QaAnswerV1 JSON，非最终归并结果不得超过8192 UTF-8字节。'
            : '按来源顺序归并会话总结。保留否定、待办与较晚修订；后文撤销优先。只用提供的来源，返回规定的JSON栏目。非最终归并结果不得超过8192 UTF-8字节。',
          [question ? 'questionPlan' : 'summaryPlan']: { version: question ? 1 : 2, stage: 'merge', final: groups.length === 1,
            source: { sessionId: input.sessionId, transcriptVersion: 'raw', inputWatermark: input.inputWatermark, inputDigest: input.inputDigest }, parts }
        })
        await onProgress({ phase: 'reducing', activity: false, validatedChunkCount: validated, totalChunkCount: plan.leaves.length })
        next.push(await execute(prompt, from, through, groups.length !== 1))
        nodes.fill(null, index, index + size)
        index += size
        await new Promise(resolve => setImmediate(resolve))
      }
      nodes = next
    }
    if (nodes.length !== 1) fail('AGENT_INTERNAL_FAILURE')
    return { text: canonicalize(nodes[0].output), usage: null }
  } finally {
    nodes.length = 0
    for (const leaf of plan.leaves) leaf.prompt = ''
  }
}

module.exports = { executeInputPlan, executeSummaryPlan: executeInputPlan }
