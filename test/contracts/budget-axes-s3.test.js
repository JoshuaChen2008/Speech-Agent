'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { deriveBudget } = require('../../src/agent/contracts/budget-axes')

const capabilities = Object.freeze({ maxInputTokens: 64000, maxOutputTokens: 4096 })

test('SEM-F16/J22/J24: budget maxTurns is taken from the recipe registration', () => {
  assert.equal(deriveBudget(capabilities, 1, [], 'user').maxTurns, 1)
  assert.equal(deriveBudget(capabilities, 3, ['search_context'], 'automatic').maxTurns, 3)
  assert.equal(deriveBudget(capabilities, 6, ['search_context', 'read_sources'], 'user').maxTurns, 6)
  assert.throws(() => deriveBudget(capabilities, 2, [], 'user'), /maxTurns|invalid/i)
  assert.throws(() => deriveBudget(capabilities, 3, ['search_context'], 'other'), /requestedBy/)
})
