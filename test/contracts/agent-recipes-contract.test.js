'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RECIPE_IDS,
  RECIPE_CATALOG,
  getRecipe,
  assertRecipeRequest,
  validateRecipeOutput,
  assertSourceRef,
  assertMemoryRef,
  assertInteractionSignalRef,
  comparisonGroupId
} = require('../../src/agent/contracts/recipes')

const expectedIds = [
  'intent.route',
  'context.ingest.session',
  'context.ingest.interaction',
  'qa.answer',
  'extract.items',
  'summary.minutes',
  'report.analysis',
  'plan.proposal',
  'text.enhance',
  'text.rewrite',
  'text.translate'
]

test('SEM-F16/J22/J24: recipe catalog is the exact eleven-entry frozen registry', () => {
  assert.deepEqual(RECIPE_IDS, expectedIds)
  assert.equal(RECIPE_CATALOG.length, 11)
  assert.equal(Object.isFrozen(RECIPE_CATALOG), true)
  assert.deepEqual(RECIPE_CATALOG.map((recipe) => recipe.recipeId), expectedIds)
  for (const recipe of RECIPE_CATALOG) {
    assert.deepEqual(Object.keys(recipe).sort(), [
      'artifactType', 'failurePolicy', 'inputScopes', 'maxTurns', 'modelPurpose',
      'outputSchemaId', 'persistence', 'recipeId', 'recipeVersion', 'toolGrants'
    ])
    assert.equal(recipe.recipeVersion, '1')
    assert.equal(Object.isFrozen(recipe), true)
    assert.equal(getRecipe(recipe.recipeId, '1'), recipe)
  }
  assert.deepEqual(getRecipe('intent.route', '1').toolGrants, [])
  assert.equal(getRecipe('qa.answer', '1').maxTurns, 3)
  assert.deepEqual(getRecipe('report.analysis', '1').toolGrants, ['search_context', 'read_sources'])
  assert.throws(() => getRecipe('unknown', '1'), /AGENT_REQUEST_INVALID/)
  assert.throws(() => getRecipe('qa.answer', '2'), /AGENT_REQUEST_INVALID/)
  assert.throws(() => assertRecipeRequest({ recipeId: 'qa.answer', recipeVersion: '1', maxTurns: 99 }), /AGENT_REQUEST_INVALID/)
})

test('SEM-F16/J22/J24: shared refs, output validation, and comparison identity are exact', () => {
  const source = { sessionId: 'session.1', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }
  const memory = { memoryId: 'memory.1', revisionId: 'revision.1' }
  const signal = { interactionId: 'interaction.1', signalKind: 'accept' }
  assert.equal(assertSourceRef(source), source)
  assert.equal(assertMemoryRef(memory), memory)
  assert.equal(assertInteractionSignalRef(signal), signal)
  assert.deepEqual(validateRecipeOutput('intent.route', '1', { recipeId: 'qa.answer', confidence: 0.83 }), {
    recipeId: 'qa.answer', confidence: 0.83
  })
  assert.throws(() => validateRecipeOutput('intent.route', '1', {
    recipeId: 'intent.route', confidence: 0.83
  }), /AGENT_OUTPUT_INVALID/)
  assert.throws(() => validateRecipeOutput('intent.route', '1', {
    recipeId: 'qa.answer', confidence: 0.83, explanation: 'private'
  }), /AGENT_OUTPUT_INVALID/)
  const expected = comparisonGroupId('qa.answer', '1', 'a'.repeat(64), 'b'.repeat(64))
  assert.match(expected, /^[0-9a-f]{64}$/)
  assert.equal(expected, comparisonGroupId('qa.answer', '1', 'a'.repeat(64), 'b'.repeat(64)))
  assert.notEqual(expected, comparisonGroupId('extract.items', '1', 'a'.repeat(64), 'b'.repeat(64)))
})

const source = { sessionId: 'session.1', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }
const memory = { memoryId: 'memory.1', revisionId: 'revision.1' }

test('SEM-F16/J22/J24: every registered output schema has an exact minimal valid shape', () => {
  const outputs = {
    'intent.route': { recipeId: 'qa.answer', confidence: 1 },
    'context.ingest.session': {
      schemaVersion: 1, experiences: [{ kind: 'topic', text: 'topic', evidence: source, confidence: 'medium' }],
      memoryCandidates: [{ scopeKind: 'session', scopeKeyProposal: null, kind: 'experience', content: 'fact', confidence: 'low', salience: 'low', evidence: source }]
    },
    'context.ingest.interaction': {
      schemaVersion: 1, experiences: [{ kind: 'topic', text: 'topic', evidence: { interactionId: 'interaction.1', signalKind: 'accept' }, confidence: 'medium' }],
      memoryCandidates: [{ scopeKind: 'global', scopeKeyProposal: null, kind: 'preference', content: 'fact', confidence: 'high', salience: 'high', evidence: { interactionId: 'interaction.1', signalKind: 'remember' } }]
    },
    'qa.answer': { schemaVersion: 1, answer: 'answer', sourceRefs: [source], memoryRefs: [memory], unresolved: [] },
    'extract.items': { schemaVersion: 1, items: [{ kind: 'todo', text: 'todo', sourceRefs: [source], confidence: 'high' }] },
    'summary.minutes': {
      schemaVersion: 1, overview: 'overview', conclusions: [{ text: 'conclusion', sourceRefs: [source] }],
      todos: [{ text: 'todo', ownerHint: null, dueHint: null, sourceRefs: [source] }], risks: [{ text: 'risk', sourceRefs: [source] }]
    },
    'report.analysis': {
      schemaVersion: 1, title: 'title', summary: 'summary', findings: [{ text: 'finding', evidence: [source, memory] }],
      timeline: [{ label: 'event', ref: source, text: 'event' }], assumptions: [], gaps: []
    },
    'plan.proposal': {
      schemaVersion: 1, objective: 'objective', facts: [{ text: 'fact', ref: source }], assumptions: [],
      plan: [{ step: 1, text: 'step', whenHint: null, dependsOn: [] }], alternatives: [], openQuestions: []
    },
    'text.enhance': { schemaVersion: 1, segments: [{ segmentId: 'segment.1', enhancedText: 'enhanced' }], notes: null },
    'text.rewrite': { schemaVersion: 1, style: 'formal', text: 'rewritten', sourceRefs: [source] },
    'text.translate': { schemaVersion: 1, targetLanguage: 'zh-Hans', basedOnRevision: 'revision.1', segments: [{ segmentId: 'segment.1', translatedText: '翻译' }] }
  }
  for (const recipeId of RECIPE_IDS) assert.doesNotThrow(() => validateRecipeOutput(recipeId, '1', outputs[recipeId]))
})

test('SEM-F16/J22/J24: output validators reject sensitive fields, invalid refs, coverage and future-step dependencies', () => {
  assert.throws(() => validateRecipeOutput('context.ingest.session', '1', {
    schemaVersion: 1, experiences: [], memoryCandidates: [{
      scopeKind: 'global', scopeKeyProposal: null, kind: 'experience', content: 'fact',
      confidence: 'high', salience: 'high', evidence: source, semanticKey: 'renderer-owned'
    }]
  }), /AGENT_OUTPUT_INVALID/)
  assert.throws(() => validateRecipeOutput('qa.answer', '1', {
    schemaVersion: 1, answer: 'answer', sourceRefs: [{ ...source, text: 'leak' }], memoryRefs: [], unresolved: []
  }), /AGENT_OUTPUT_INVALID/)
  assert.throws(() => validateRecipeOutput('plan.proposal', '1', {
    schemaVersion: 1, objective: 'objective', facts: [], assumptions: [],
    plan: [{ step: 1, text: 'step', whenHint: null, dependsOn: [2] }], alternatives: [], openQuestions: []
  }), /AGENT_OUTPUT_INVALID/)
  assert.throws(() => validateRecipeOutput('text.translate', '1', {
    schemaVersion: 1, targetLanguage: 'zh-hans', basedOnRevision: 'revision.1', segments: []
  }), /AGENT_OUTPUT_INVALID/)
})
