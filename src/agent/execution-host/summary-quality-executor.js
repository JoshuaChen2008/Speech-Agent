'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { assertSummaryTopicIndex, validateRecipeOutput } = require('../contracts/recipes')
const { outputInvalid } = require('../contracts/output-validation')
const { POLICY, STAGES, assertSummaryBuffer } = require('../contracts/summary-quality')

function cancelled (signal) { if (signal?.aborted) throw Object.assign(new Error('AGENT_CANCELLED'), { code: 'AGENT_CANCELLED' }) }
function checkReferences (value, input, from, through, allowed) {
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, 'fromEventOrder')) {
    if (value.sessionId !== input.sessionId || value.transcriptVersion !== 'raw' || value.fromEventOrder < from || value.throughEventOrder > through ||
        allowed && !allowed.some(ref => canonicalize(ref) === canonicalize(value))) throw outputInvalid('source_reference', 'sourceRefs')
  }
  for (const child of Object.values(value)) checkReferences(child, input, from, through, allowed)
}
function sourceRefs (value, refs = []) {
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'sessionId') && Object.hasOwn(value, 'transcriptVersion') && Object.hasOwn(value, 'fromEventOrder')) refs.push(value)
    else for (const child of Object.values(value)) sourceRefs(child, refs)
  }
  return refs
}
async function executeSummaryQuality ({ input, plan, invoke, signal, onProgress = async () => {} }) {
  if (plan.policyVersion !== POLICY || !plan.quality) throw Object.assign(new Error('AGENT_REQUEST_INVALID'), { code: 'AGENT_REQUEST_INVALID' })
  let nodes = []; let validated = 0; let loops = 0; let node = 0
  const retainedBytes = () => Buffer.byteLength(canonicalize(input.events), 'utf8') * 4 +
    plan.leaves.reduce((sum, leaf) => sum + Buffer.byteLength(leaf.prompt, 'utf8') * 2, 0) +
    Buffer.byteLength(canonicalize(nodes), 'utf8') * 2
  // Count retained source, plan and results conservatively (including UTF-16
  // copies), reserving 32 MiB for the bounded Pi/HTTP exchange and tool history.
  const checkBuffers = (...values) => assertSummaryBuffer(retainedBytes() + 32 * 1024 * 1024 +
    values.reduce((sum, value) => sum + Buffer.byteLength(typeof value === 'string' ? value : canonicalize(value), 'utf8') * 2, 0))
  checkBuffers()
  const execute = async (source, from, through, role, final, allowed) => {
    let index = null; let draft = null; let verified = null
    const nodeIndex = ++node
    try {
      for (const summaryStage of STAGES) {
        cancelled(signal)
        if (++loops > plan.quality.loopLimit || loops > 1152) throw Object.assign(new Error('AGENT_BUDGET_EXCEEDED'), { code: 'AGENT_BUDGET_EXCEEDED' })
        const payload = { userPrompt: plan.userPrompt, summaryPlan: { version: 3, stage: summaryStage, nodeRole: role, source,
          ...(role !== 'merge' ? { authorizedSourceRef: { sessionId: input.sessionId, transcriptVersion: 'raw', fromEventOrder: from, throughEventOrder: through } } : {}),
          ...(summaryStage === 'drafting_minutes' ? { topicIndex: index } : {}),
          ...(summaryStage === 'verifying_sources' ? { draft } : {}),
          instruction: `${role === 'merge' ? '依据已核对的连续分块结果归并并核对，不声称重新读取整场原文。' : '完整读取提供的原文，可以纠正目录遗漏。'}本阶段JSON最多${summaryStage === 'organizing_topics' || !final ? plan.quality.intermediateBytes : plan.quality.finalBytes} UTF-8字节，不裁切、不编造。` } }
        const prompt = canonicalize(payload)
        checkBuffers(source, index, draft, prompt)
        const promptBytes = Buffer.byteLength(JSON.stringify(prompt), 'utf8')
        if (promptBytes > plan.promptLimit) throw Object.assign(new Error('AGENT_BUDGET_EXCEEDED'), { code: 'AGENT_BUDGET_EXCEEDED', diagnosticMetrics: { actual: promptBytes, limit: plan.promptLimit, unit: 'bytes' } })
        await onProgress({ phase: role === 'merge' ? 'reducing' : 'waiting_model', summaryStage, nodeRole: role, nodeIndex, loopCount: loops,
          activity: false, validatedChunkCount: validated, totalChunkCount: plan.leaves.length })
        const result = await invoke(prompt, summaryStage)
        cancelled(signal)
        checkBuffers(source, index, draft, prompt, result.text)
        const size = Buffer.byteLength(result.text, 'utf8')
        const limit = summaryStage === 'organizing_topics' || !final ? plan.quality.intermediateBytes : plan.quality.finalBytes
        if (size > limit) throw outputInvalid('output_size', 'output', size, limit)
        let output
        try { output = JSON.parse(result.text) } catch { throw outputInvalid('json') }
        if (summaryStage === 'organizing_topics') assertSummaryTopicIndex(output)
        else validateRecipeOutput('summary.minutes', '3', output)
        const canonicalSize = Buffer.byteLength(canonicalize(output), 'utf8')
        if (canonicalSize > limit) throw outputInvalid('output_size', 'output', canonicalSize, limit)
        checkReferences(output, input, from, through, allowed)
        if (summaryStage === 'organizing_topics') index = output
        else if (summaryStage === 'drafting_minutes') { draft = output; index = null }
        else { verified = output; draft = null }
      }
      return { fromEventOrder: from, throughEventOrder: through, output: verified }
    } finally { index = null; draft = null }
  }
  try {
    for (const leaf of plan.leaves) {
      const source = JSON.parse(leaf.prompt).summaryPlan
      nodes.push(await execute(source, leaf.fromEventOrder, leaf.throughEventOrder, plan.leaves.length === 1 ? 'whole' : 'leaf', plan.leaves.length === 1))
      leaf.prompt = ''
      validated++
      await onProgress({ phase: 'validating', activity: true, validatedChunkCount: validated, totalChunkCount: plan.leaves.length })
      await new Promise(resolve => setImmediate(resolve))
    }
    for (const groups of plan.levels) {
      const next = []; let offset = 0
      for (const size of groups) {
        const parts = nodes.slice(offset, offset + size)
        if (size === 1) next.push(parts[0])
        else next.push(await execute({ kind: 'verified_chunks', parts }, parts[0].fromEventOrder, parts.at(-1).throughEventOrder, 'merge', groups.length === 1, sourceRefs(parts)))
        nodes.fill(null, offset, offset + size); offset += size
        await new Promise(resolve => setImmediate(resolve))
      }
      nodes = next
    }
    if (nodes.length !== 1 || node !== plan.nodeCount) throw Object.assign(new Error('AGENT_INTERNAL_FAILURE'), { code: 'AGENT_INTERNAL_FAILURE' })
    return { text: canonicalize(nodes[0].output), usage: null }
  } finally { nodes.length = 0; for (const leaf of plan.leaves) leaf.prompt = '' }
}
module.exports = { executeSummaryQuality }
