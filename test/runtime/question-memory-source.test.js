'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { questionSource, allowsQuestionCandidate } = require('../../src/agent/personal-context/question-memory-source')

function candidate (text, attribution, kind = 'preference') {
  return { kind, attribution, scopeKind: 'global', userEvidence: { fromCodePoint: 0, throughCodePoint: Array.from(text).length } }
}

test('SEM-F26/F32/J21: only trusted user text supplies personal evidence and unaccepted results stay outside input', () => {
  const text = '以后解释技术时先给一个例子'
  const input = questionSource({ signalKind: 'prompt', prompt: text, editText: null, result: { answer: '助手推测用户是工程师' } })
  assert.equal(input.userText, text)
  assert.equal(input.acceptedContent, null)
  assert.equal(allowsQuestionCandidate(candidate(text, 'long_term_requirement'), input), true)
  const accepted = questionSource({ signalKind: 'accept', prompt: null, editText: null, result: { answer: '被采纳结果' } })
  assert.equal(accepted.userText, null)
  assert.equal(allowsQuestionCandidate(candidate('被采纳结果', 'self_statement', 'experience'), accepted), false)
})

test('SEM-F26/F27/J21: knowledge questions, temporary limits, hypothetical roles and quoted third parties do not become personal facts', () => {
  for (const [text, attribution, kind] of [
    ['缓存是什么', 'self_statement', 'experience'],
    ['这次只列三点', 'long_term_requirement', 'preference'],
    ['假如我是项目负责人', 'self_statement', 'project_fact'],
    ['同事说他喜欢简短回答', 'long_term_requirement', 'preference'],
    ['“我负责项目X”', 'self_statement', 'experience'],
    ['替朋友问：我该怎样负责项目X', 'self_statement', 'experience'],
    ['以后解释先给例子', 'quoted', 'preference'],
    ['我负责项目X', 'third_party', 'project_fact']
  ]) {
    const input = questionSource({ signalKind: 'prompt', prompt: text, editText: null, result: null })
    assert.equal(allowsQuestionCandidate(candidate(text, attribution, kind), input), false, attribution)
  }
})

test('SEM-F26/F32/J21: user evidence uses Unicode code points and cannot cross quoted text or exceed the frozen source', () => {
  const text = '😀我负责项目X。朋友说“我喜欢短回答”。以后解释先给例子。'
  const input = questionSource({ signalKind: 'prompt', prompt: text, editText: null, result: null })
  const value = candidate(text, 'self_statement', 'experience')
  value.userEvidence = { fromCodePoint: 1, throughCodePoint: 7 }
  assert.equal(allowsQuestionCandidate(value, input), true)
  value.userEvidence = { fromCodePoint: 0, throughCodePoint: Array.from(text).length + 1 }
  assert.equal(allowsQuestionCandidate(value, input), false)
  value.userEvidence = { fromCodePoint: 14, throughCodePoint: 21 }
  assert.equal(allowsQuestionCandidate(value, input), false)
})

test('SEM-F26/J21: repeated patterns require a user expression of style and remain candidates', () => {
  for (const [text, expected] of [['请给一个例子解释缓存', true], ['缓存是什么', false]]) {
    const input = questionSource({ signalKind: 'prompt', prompt: text, editText: null, result: null })
    assert.equal(allowsQuestionCandidate(candidate(text, 'repeated_pattern'), input), expected)
  }
})
