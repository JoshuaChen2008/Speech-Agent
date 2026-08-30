'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  deterministicRoute,
  isRouteFallback,
  routeTarget,
  TARGET_RECIPE_IDS
} = require('../../src/agent/execution-host/intent-router')

test('SEM-F16/SEM-F28/J22/J24: deterministic route uses only frozen scope and controlled keywords', () => {
  assert.deepEqual(TARGET_RECIPE_IDS.length, 10)
  assert.equal(deterministicRoute({ scope: { kind: 'session', reference: 'session.one' }, prompt: '请整理会议纪要' }).recipeId, 'summary.minutes')
  assert.equal(deterministicRoute({ scope: { kind: 'selection', reference: 'selection.one' }, prompt: '把这段翻译成英文' }).recipeId, 'text.translate')
  assert.equal(deterministicRoute({ scope: { kind: 'selection', reference: 'selection.one' }, prompt: '请重写并改得正式' }).recipeId, 'text.rewrite')
  assert.equal(deterministicRoute({ scope: { kind: 'session', reference: 'session.one' }, prompt: '提取待办和风险' }).recipeId, 'extract.items')
  assert.equal(deterministicRoute({ scope: { kind: 'project', reference: 'project.one' }, prompt: '帮我分析这些内容' }).recipeId, 'report.analysis')
  assert.equal(deterministicRoute({ scope: { kind: 'project', reference: 'project.one' }, prompt: '给出一个执行计划' }).recipeId, 'plan.proposal')
  assert.equal(deterministicRoute({ scope: { kind: 'session', reference: 'session.one' }, prompt: '没有受控关键词' }).recipeId, 'qa.answer')
  assert.throws(() => deterministicRoute({ scope: { kind: 'selection', reference: 'selection.one' }, prompt: 'x', model: 'forbidden' }), (error) => error.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F16/SEM-F28/J22: fallback classifier has exactly five triggers and does not use confidence thresholds', () => {
  assert.equal(isRouteFallback({ eligibility: 'credential_unavailable', error: null, result: null }), true)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: { code: 'AGENT_PROVIDER_TIMEOUT' }, result: null }), true)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: { code: 'AGENT_OUTPUT_INVALID' }, result: null }), true)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: { code: 'AGENT_WORKER_EXITED' }, result: null }), true)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: null, result: { recipeId: 'intent.route', confidence: 1 } }), true)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: null, result: { recipeId: 'qa.answer', confidence: 0.01 } }), false)
  assert.equal(isRouteFallback({ eligibility: 'ready', error: { code: 'AGENT_CANCELLED' }, result: null }), false)
  assert.equal(routeTarget({ recipeId: 'qa.answer', confidence: 0.01 }), 'qa.answer')
  assert.equal(routeTarget({ recipeId: 'intent.route', confidence: 1 }), null)
  assert.equal(routeTarget({ recipeId: 'qa.answer', confidence: 1, alternatives: [] }), null)
})

