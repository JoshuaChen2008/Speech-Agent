'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getRecipe, validateRecipeOutput } = require('../../src/agent/contracts/recipes')

function interactionOutput () {
  return {
    schemaVersion: 2,
    questionSummary: '希望技术解释先给一个例子。',
    experiences: [],
    memoryCandidates: [{
      scopeKind: 'global', scopeKeyProposal: null, kind: 'preference',
      content: '技术解释先给一个例子', confidence: 'high', salience: 'high',
      evidence: { interactionId: 'interaction.question', signalKind: 'prompt' },
      attribution: 'long_term_requirement', entityKeys: [],
      userEvidence: { fromCodePoint: 0, throughCodePoint: 16 }
    }],
    associations: []
  }
}

test('SEM-F26/F30/J21: versioned personal context ingest keeps legacy bindings and static Loop grants', () => {
  for (const id of ['context.ingest.interaction', 'context.ingest.session']) {
    assert.equal(getRecipe(id, '1').outputSchemaId, 'ContextIngestV1')
    const recipe = getRecipe(id, '2')
    assert.equal(recipe.outputSchemaId, 'ContextIngestV2')
    assert.equal(recipe.maxTurns, 3)
    assert.deepEqual(recipe.toolGrants, [])
    assert.equal(recipe.modelPurpose, 'information_extraction')
    validateRecipeOutput(id, '1', { schemaVersion: 1, experiences: [], memoryCandidates: [] })
  }
  validateRecipeOutput('context.ingest.interaction', '2', interactionOutput())
  assert.throws(() => validateRecipeOutput('context.ingest.interaction', '1', interactionOutput()), { code: 'AGENT_OUTPUT_INVALID' })
})

test('SEM-F27/F32/J21: candidate attribution is separate from user confirmation and has bounded user evidence', () => {
  for (const mutate of [
    (v) => { v.memoryCandidates[0].origin = 'explicit' },
    (v) => { v.memoryCandidates[0].attribution = 'user_confirmed' },
    (v) => { v.memoryCandidates[0].userEvidence.throughCodePoint = 0 },
    (v) => { v.memoryCandidates[0].userEvidence.throughCodePoint = 513 },
    (v) => { v.memoryCandidates[0].entityKeys = Array(9).fill('项目X') },
    (v) => { v.memoryCandidates[0].kind = 'personal_background' },
    (v) => { v.questionSummary = '摘'.repeat(513) },
    (v) => { v.questionSummary = '😀'.repeat(513) }
  ]) {
    const value = interactionOutput()
    mutate(value)
    assert.throws(() => validateRecipeOutput('context.ingest.interaction', '2', value), { code: 'AGENT_OUTPUT_INVALID' })
  }
})

test('SEM-F26/F30/J28: session associations carry both frozen memory revision and transcript evidence', () => {
  const output = {
    schemaVersion: 2, questionSummary: null, experiences: [], memoryCandidates: [],
    associations: [{
      memoryRef: { memoryId: 'memory.project', revisionId: 'revision.confirmed' },
      matchKeys: ['项目X'], relation: '用户负责的项目在本次会话讨论接口变更。',
      evidence: { sessionId: 'session.project', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }
    }]
  }
  validateRecipeOutput('context.ingest.session', '2', output)
  assert.throws(() => validateRecipeOutput('context.ingest.interaction', '2', output), { code: 'AGENT_OUTPUT_INVALID' })
  for (const mutate of [
    (v) => { delete v.associations[0].memoryRef.revisionId },
    (v) => { v.associations[0].matchKeys = [] },
    (v) => { v.associations[0].evidence.throughEventOrder = 0 },
    (v) => { v.questionSummary = '会话不是用户提问' }
  ]) {
    const value = structuredClone(output)
    mutate(value)
    assert.throws(() => validateRecipeOutput('context.ingest.session', '2', value), { code: 'AGENT_OUTPUT_INVALID' })
  }
})

test('SEM-F26/F32/J21: both ingest versions have exact output instructions for the same production Loop', () => {
  const { outputDirectiveFor } = require('../../src/agent/contracts/recipe-output-directives')
  for (const id of ['context.ingest.interaction', 'context.ingest.session']) {
    for (const version of ['1', '2']) {
      const recipe = getRecipe(id, version)
      const directive = outputDirectiveFor(recipe)
      validateRecipeOutput(id, version, structuredClone(directive.example))
    }
  }
})
