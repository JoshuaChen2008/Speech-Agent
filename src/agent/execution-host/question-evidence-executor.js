'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { validateRecipeOutput } = require('../contracts/recipes')
const fail = code => { const error = new Error(code); error.code = code; throw error }

function nodeCount (leaves) {
  let count = leaves
  while (leaves > 1) { leaves = Math.ceil(leaves / 4); count += leaves }
  if (count > 384) fail('AGENT_BUDGET_EXCEEDED')
  return count
}

async function executeQuestionEvidence ({ evidence, invoke, signal, promptByteLimit, validateMemoryRefs }) {
  let nodes = []
  const execute = async (prompt, allowedRefs, intermediate) => {
    if (signal?.aborted) fail('AGENT_CANCELLED')
    if (Buffer.byteLength(JSON.stringify(prompt)) > promptByteLimit) fail('AGENT_BUDGET_EXCEEDED')
    const result = await invoke(prompt)
    let output
    try { output = typeof result.text === 'string' ? JSON.parse(result.text) : result.output
      validateRecipeOutput('qa.answer', '4', output)
    } catch { fail('AGENT_OUTPUT_INVALID') }
    if (output.coverage !== null || output.sourceRefs.some(ref => !allowedRefs.some(allowed => canonicalize(ref) === canonicalize(allowed)))) fail('AGENT_OUTPUT_INVALID')
    validateMemoryRefs(output)
    if (intermediate && Buffer.byteLength(canonicalize(output)) > 8192) fail('AGENT_OUTPUT_INVALID')
    return output
  }
  try {
    for (const leaf of evidence.leaves) {
      nodes.push(await execute(leaf.prompt, leaf.sourceRefs, evidence.leaves.length > 1))
      await new Promise(resolve => setImmediate(resolve))
    }
    while (nodes.length > 1) {
      const next = []
      for (let index = 0; index < nodes.length; index += 4) {
        const parts = nodes.slice(index, index + 4)
        if (parts.length === 1) { next.push(parts[0]); continue }
        const refs = parts.flatMap(part => part.sourceRefs)
        const prompt = canonicalize({ userPrompt: evidence.userPrompt, questionMerge: { parts, coverage: evidence.coverage },
          instruction: '归并全部冻结批次的逐结论证据，保留来源、否定和较晚修订。只引用parts已有来源；没有覆盖全部原文时不得保证无遗漏、精确计数或不存在。返回QaAnswerV2，coverage:null。若输出条数受限，在unresolved说明。' })
        next.push(await execute(prompt, refs, Math.ceil(nodes.length / 4) > 1))
        await new Promise(resolve => setImmediate(resolve))
      }
      nodes = next
    }
    if (nodes.length !== 1) fail('AGENT_INTERNAL_FAILURE')
    return { text: canonicalize(nodes[0]), usage: null }
  } finally {
    nodes.length = 0
    evidence.leaves.forEach(leaf => { leaf.prompt = '' })
  }
}

module.exports = { executeQuestionEvidence, nodeCount }
