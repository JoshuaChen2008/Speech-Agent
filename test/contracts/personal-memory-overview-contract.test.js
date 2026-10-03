'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { getRecipe, validateRecipeOutput } = require('../../src/agent/contracts/recipes')
test('SEM-F37/J28: synthesis is a bounded tool-free recipe with exact source identity', () => {
  const recipe = getRecipe('context.synthesize', '1')
  assert.equal(recipe.modelPurpose, 'summary'); assert.equal(recipe.maxTurns, 3); assert.deepEqual(recipe.toolGrants, [])
  const output = { schemaVersion: 1, sections: [{ category: 'facts', title: '背景', text: '受控内容', memoryRefs: [{ memoryId: 'memory.synthetic', revisionId: 'revision.synthetic' }], episodeRefs: [] }] }
  assert.equal(validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output), output)
  for (const invalid of [ { ...output, origin: 'explicit' }, { ...output, sections: Array(13).fill(output.sections[0]) }, { ...output, sections: [{ ...output.sections[0], memoryRefs: [] }] } ]) assert.throws(() => validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, invalid))
})
