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
const { outputDirectiveFor } = require('../../src/agent/contracts/recipe-output-directives')

const expectedIds = [
  'intent.route',
  'context.ingest.session',
  'context.ingest.interaction',
  'context.synthesize',
  'qa.answer',
  'extract.items',
  'summary.minutes',
  'report.analysis',
  'plan.proposal',
  'text.enhance',
  'text.rewrite',
  'text.translate'
]

test('SEM-F16/J22/J24: twelve recipe ids map to a frozen versioned registry', () => {
  assert.deepEqual(RECIPE_IDS, expectedIds)
  assert.equal(RECIPE_CATALOG.length, 21)
  assert.equal(Object.isFrozen(RECIPE_CATALOG), true)
  assert.deepEqual([...new Set(RECIPE_CATALOG.map((recipe) => recipe.recipeId))], expectedIds)
  for (const recipe of RECIPE_CATALOG) {
    assert.deepEqual(Object.keys(recipe).sort(), [
      'artifactType', 'failurePolicy', 'inputScopes', 'maxTurns', 'modelPurpose',
      'outputSchemaId', 'persistence', 'recipeId', 'recipeVersion', 'toolGrants'
    ])
    assert.ok(['1', ...(['summary.minutes', 'qa.answer', 'context.ingest.session', 'context.ingest.interaction', 'context.synthesize'].includes(recipe.recipeId) ? ['2'] : []),
      ...(['qa.answer', 'context.ingest.session'].includes(recipe.recipeId) ? ['3'] : []),
      ...(recipe.recipeId === 'qa.answer' ? ['4', '5'] : [])].includes(recipe.recipeVersion))
    assert.equal(Object.isFrozen(recipe), true)
    assert.equal(getRecipe(recipe.recipeId, recipe.recipeVersion), recipe)
  }
  assert.deepEqual(getRecipe('intent.route', '1').toolGrants, [])
  assert.equal(getRecipe('qa.answer', '1').maxTurns, 3)
  const summaryV1 = getRecipe('summary.minutes', '1')
  const summaryV2 = getRecipe('summary.minutes', '2')
  assert.deepEqual({ ...summaryV2, recipeVersion: '1' }, summaryV1)
  assert.deepEqual(summaryV2.toolGrants, ['search_context'])
  assert.deepEqual(getRecipe('report.analysis', '1').toolGrants, ['search_context', 'read_sources'])
  assert.throws(() => getRecipe('unknown', '1'), /AGENT_REQUEST_INVALID/)
  assert.deepEqual({ ...getRecipe('qa.answer', '2'), recipeVersion: '1' }, getRecipe('qa.answer', '1'))
  assert.deepEqual(getRecipe('qa.answer', '3').inputScopes, ['session'])
  assert.deepEqual({ ...getRecipe('qa.answer', '3'), recipeVersion: '2', inputScopes: getRecipe('qa.answer', '2').inputScopes }, getRecipe('qa.answer', '2'))
  assert.deepEqual({ ...getRecipe('qa.answer', '5'), recipeVersion: '4' }, getRecipe('qa.answer', '4'))
  assert.throws(() => getRecipe('qa.answer', '6'), /AGENT_REQUEST_INVALID/)
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
    'context.synthesize': { schemaVersion: 1, sections: [] },
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

test('SEM-F39/SEM-F28/J31-SIZE: every registered recipe identity carries a single-line JSON output directive', () => {
  for (const recipe of RECIPE_CATALOG) {
    const directive = outputDirectiveFor(recipe)
    assert.equal(typeof directive.systemPrompt, 'string')
    assert.equal(/[\u0000-\u001f\u007f]/u.test(directive.systemPrompt), false, `${recipe.recipeId}@${recipe.recipeVersion} must stay on one line`)
    assert.equal(Buffer.byteLength(directive.systemPrompt, 'utf8') <= 16 * 1024, true)
    assert.equal(directive.systemPrompt.includes('只输出一个 JSON 对象'), true)
    assert.equal(directive.systemPrompt.includes('不要 Markdown'), true)
    assert.equal(directive.systemPrompt.includes('不可信数据'), true)
    assert.equal(directive.systemPrompt.includes(JSON.stringify(directive.example)), true)
    assert.doesNotThrow(() => validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, directive.example))
  }
  assert.throws(() => outputDirectiveFor({ recipeId: 'summary.minutes', recipeVersion: '3' }), /AGENT_REQUEST_INVALID/)
})

test('SEM-F39/J31-SIZE: the summary directive pins the minutes structure without inventing source identity', () => {
  const directive = outputDirectiveFor(getRecipe('summary.minutes', '2'))
  assert.equal(directive.systemPrompt.includes('schemaVersion'), true)
  assert.equal(directive.systemPrompt.includes('overview'), true)
  assert.equal(directive.systemPrompt.includes('todos'), true)
  assert.equal(directive.systemPrompt.includes('2000'), true)
  assert.equal(directive.systemPrompt.includes('不得编造'), true)
  assert.deepEqual(directive.example.sourceRefs, undefined)
  for (const item of [...directive.example.conclusions, ...directive.example.todos, ...directive.example.risks]) {
    assert.deepEqual(item.sourceRefs, [])
  }
  const v1Directive = outputDirectiveFor(getRecipe('summary.minutes', '1'))
  assert.equal(v1Directive.systemPrompt, directive.systemPrompt)
})

test('SEM-F39/SEM-F28/J31-SIZE: routing, ingest, and remaining recipes keep their own output structures', () => {
  const route = outputDirectiveFor(getRecipe('intent.route', '1')).systemPrompt
  assert.equal(route.includes('qa.answer'), true)
  assert.equal(route.includes('summary.minutes'), true)
  assert.equal(route.includes('confidence'), true)
  assert.equal(route.includes('overview'), false, 'routing must not adopt the minutes structure')

  const ingest = outputDirectiveFor(getRecipe('context.ingest.session', '1')).systemPrompt
  assert.equal(ingest.includes('experiences'), true)
  assert.equal(ingest.includes('memoryCandidates'), true)
  assert.equal(ingest.includes('semanticKey'), true, 'storage ownership must stay explicit')
  const interaction = outputDirectiveFor(getRecipe('context.ingest.interaction', '1')).systemPrompt
  assert.equal(interaction.includes('interactionId'), true)
  assert.equal(interaction.includes('signalKind'), true)

  const answer = outputDirectiveFor(getRecipe('qa.answer', '1')).systemPrompt
  assert.equal(answer.includes('memoryRefs'), true)
  assert.equal(answer.includes('ownerHint'), false, 'qa.answer must not adopt todo fields')
})
