'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')

test('SEM-T15 / J24 正式 Agent 首版设计追踪保持闭合', () => {
  const context = read('CONTEXT.md')
  const semantic = read('docs/semantic-contract.md')
  const testing = read('docs/testing-strategy.md')
  const todo = read('docs/agent-mvp-todo.md')
  const interfaces = read('docs/agent-mvp-interface-contract.md')
  const dataArchitecture = read('docs/data-architecture.md')
  const reconciliationAdr = read('docs/adr/0008-terminal-session-agent-job-reconciliation.md')
  const adr = read('docs/adr/0009-deterministic-agent-input-planning.md')
  const migrationAdr = read('docs/adr/0010-separate-isolated-and-formal-agent-migration-catalogs.md')

  for (const term of [
    '字幕提交边界',
    '后台 Agent 任务',
    'Agent 处理资格',
    '会后结构化纪要',
    '增强文本',
    '个人记忆',
    '个人记忆自动处理边界',
    '确认关键词'
  ]) assert.match(context, new RegExp(`\\*\\*${term}`))

  assert.match(semantic, /\*\*SEM-F28\*\*[\s\S]*零条首次稳定转写/)
  assert.match(semantic, /\*\*SEM-F28\*\*[\s\S]*不得静默截断/)
  assert.match(semantic, /\*\*SEM-F28\*\*[\s\S]*outside_automatic_window/)
  assert.match(semantic, /\*\*SEM-T15\*\*[\s\S]*J24/)
  assert.match(semantic, /\*\*SEM-T15\*\*[\s\S]*SEM-T07\/J3–J7/)
  assert.match(testing, /\| J24 \|/)
  assert.match(testing, /J23-B01–B16/)
  assert.match(testing, /J24-B01–B33/)

  const isolatedBoundaryCases = todo.match(/^\| J23-B\d{2} \|/gm) || []
  assert.equal(isolatedBoundaryCases.length, 16)
  const boundaryCases = todo.match(/^\| J24-B\d{2} \|/gm) || []
  assert.equal(boundaryCases.length, 33)
  for (const id of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11']) {
    assert.match(todo, new RegExp(`\\| ${id} \\|`))
  }
  for (const id of ['J7', 'J12', 'J13', 'J20', 'J21', 'J22', 'J23', 'J24', 'DB7']) {
    assert.match(todo, new RegExp(`\\b${id}\\b`))
  }

  for (const port of [
    'TranscriptReader',
    'AgentInputPlanner',
    'MemoryReader',
    'ModelGateway',
    'ArtifactWriter',
    'MemoryCandidateSink',
    'JobController',
    'RecognitionProviderRegistry',
    'AgentModelProviderRegistry'
  ]) assert.match(interfaces, new RegExp(port))

  for (const eligibility of [
    'ready',
    'no_committed_transcript',
    'outside_automatic_window',
    'agent_disabled',
    'provider_not_configured',
    'cloud_disclosure_required',
    'credential_unavailable',
    'local_model_not_ready',
    'session_not_terminal'
  ]) assert.match(interfaces, new RegExp(`'${eligibility}'`))
  assert.match(interfaces, /判定顺序固定为/)
  for (const field of [
    'agentEnabled',
    'memoryEnabled',
    'automaticProcessingSince',
    'memoryProcessingSince',
    'providerId',
    'providerKind',
    'cloudDisclosureAccepted',
    'credentialAvailable',
    'localModelReady'
  ]) assert.match(interfaces, new RegExp(field))
  assert.match(interfaces, /agent\.applyTaskPolicy/)
  assert.match(interfaces, /agent\.claimNextJob[\s\S]*claimIdempotencyKey/)
  assert.match(interfaces, /agent\.commitArtifact[\s\S]*同一事务中写产物/)
  assert.match(interfaces, /agent\.commitMemoryCandidates[\s\S]*低价值\/低置信/)
  assert.match(interfaces, /agent\.deleteSessionData[\s\S]*tombstone/)
  assert.match(interfaces, /getSessionDetail[\s\S]*不返回凭据、lease owner、lease 到期时点/)

  for (const channel of [
    'agent-settings:get',
    'agent-settings:update',
    'agent-credential:set',
    'recognition-terms:list',
    'agent-session:get',
    'agent-job:request',
    'agent-job:cancel',
    'agent-debug:get',
    'agent-debug:confirm'
  ]) assert.match(interfaces, new RegExp(channel))

  assert.match(reconciliationAdr, /no_committed_transcript/)
  assert.match(reconciliationAdr, /automaticProcessingSince/)
  assert.match(reconciliationAdr, /memoryProcessingSince/)
  assert.match(adr, /全部首次稳定转写/)
  assert.match(adr, /Unicode code point/)
  assert.match(adr, /不持久化分块正文或模型中间输出/)
  assert.match(migrationAdr, /候选 Agent v3/)
  assert.match(migrationAdr, /正式 Agent v3/)
  assert.match(migrationAdr, /交叉打开失败/)
  assert.match(dataArchitecture, /provider_kind/)
  assert.match(dataArchitecture, /agent_claim_receipts/)
  assert.match(dataArchitecture, /session_deletion_tombstones/)
  assert.match(dataArchitecture, /revision 必须属于同一 `memory_id`/)
  assert.match(dataArchitecture, /交叉打开必须 fail closed/)
  assert.match(todo, /J24-B25[\s\S]*三项后台 Agent 任务/)
  assert.match(todo, /J24-B26[\s\S]*outside_automatic_window/)
  assert.match(todo, /J24-B30[\s\S]*报告不含字幕正文/)
  assert.match(todo, /只防止设计追踪漂移，不构成任何产品旅程证据/)
  assert.match(todo, /learn\.microsoft\.com\/en-us\/azure\/architecture\/patterns\/asynchronous-request-reply/)
  assert.match(todo, /w3\.org\/WAI\/WCAG21\/Techniques\/aria\/ARIA19/)
})
