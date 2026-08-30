'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ALLOWED_ROLES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  IPC_CHANNELS,
  MANAGE_COMMANDS,
  PRELOAD_GLOBALS,
  PRELOAD_METHODS,
  assertChangedEvent,
  assertFixture,
  assertFixturePrivacy,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse,
  isSupportedContract
} = require('../../src/agent/contracts')
const fixtures = require('../../src/agent/contracts/fixtures/agent-context-ui')
const rejectedSemanticKey = require('../../src/agent/contracts/fixtures/agent-context-ui/v1.1.0/negative-semantic-key-request.json')

const allFixtures = Object.values(fixtures)

test('SEM-F30/J21: S1 UI contract identity, roles, seams and commands are frozen independently', () => {
  assert.equal(CONTRACT_ID, 'speech-agent.personal-context.ui')
  assert.equal(CONTRACT_VERSION, '1.1.0')
  assert.deepEqual(ALLOWED_ROLES, ['history', 'settings'])
  assert.deepEqual(IPC_CHANNELS, {
    changed: 'agent-context:changed',
    getOverview: 'agent-context:get-overview',
    manage: 'agent-context:manage'
  })
  assert.deepEqual(MANAGE_COMMANDS, [
    'delete',
    'forget',
    'remember',
    'set_processing',
    'update',
    'view'
  ])
  assert.deepEqual(PRELOAD_GLOBALS, {
    history: 'historyApi',
    settings: 'shell'
  })
  assert.deepEqual(PRELOAD_METHODS, {
    getOverview: 'getAgentContextOverview',
    manage: 'manageAgentContext',
    onChanged: 'onAgentContextChanged'
  })
  assert.equal(isSupportedContract(CONTRACT_ID, CONTRACT_VERSION), true)
  assert.equal(isSupportedContract(CONTRACT_ID, '1.0.0'), false)
  assert.equal(isSupportedContract('project-v5', CONTRACT_VERSION), false)
})

test('SEM-F30/J21: every preview-only fixture passes the same embedded production validators', () => {
  assert.ok(allFixtures.length >= 10)
  for (const fixture of allFixtures) {
    assert.equal(assertFixture(fixture), fixture)
    assert.equal(assertFixturePrivacy(fixture), fixture)
    assert.equal(fixture.preview_only, true)
    assert.equal(fixture.j21_evidence, false)
    assert.equal(fixture.contract_id, CONTRACT_ID)
    assert.equal(fixture.contract_version, CONTRACT_VERSION)
  }
})

test('SEM-F30/J21: fixtures cover empty, loading, ready, validation, conflict, permission, unavailable and reload', () => {
  const scenarios = new Set(allFixtures.map((fixture) => fixture.scenario))
  for (const scenario of [
    'empty',
    'loading',
    'ready',
    'validation_error',
    'revision_conflict',
    'permission_failure',
    'unavailable',
    'reload_result'
  ]) {
    assert.equal(scenarios.has(scenario), true, `missing fixture scenario ${scenario}`)
  }
})

test('SEM-F30/J21: exact validators reject missing fields, unknown fields and wrong types', () => {
  const overviewRequest = structuredClone(fixtures.overviewEmpty.request)
  delete overviewRequest.contract_version
  assert.throws(() => assertGetOverviewRequest(overviewRequest), /contract_version/)

  const overviewResponse = structuredClone(fixtures.overviewReady.response)
  overviewResponse.snapshot.future_field = true
  assert.throws(() => assertGetOverviewResponse(overviewResponse), /future_field/)

  const manageRequest = structuredClone(fixtures.manageRememberProcessing.request)
  manageRequest.command.entry.display_text = 7
  assert.throws(() => assertManageRequest(manageRequest), /display_text/)

  const manageResponse = structuredClone(fixtures.manageDeleteResult.response)
  manageResponse.result.deleted.evidence = '1'
  assert.throws(() => assertManageResponse(manageResponse), /evidence/)

  const changedEvent = structuredClone(fixtures.changedReload.event)
  changedEvent.revision = -1
  assert.throws(() => assertChangedEvent(changedEvent), /revision/)
})

test('SEM-F30/J21: remember omits the storage-owned semantic key and cannot masquerade as a confirmed recognition term', () => {
  const request = structuredClone(fixtures.manageRememberProcessing.request)
  assert.equal(assertManageRequest(request), request)
  assert.deepEqual(Object.keys(request.command.entry).sort(), [
    'display_text',
    'kind',
    'scope'
  ])

  assert.throws(() => assertManageRequest(rejectedSemanticKey.request), /semantic_key/)

  const freeRow = structuredClone(request)
  freeRow.command.entry = { text: 'please remember anything' }
  assert.throws(() => assertManageRequest(freeRow), /entry/)

  const recognitionLeak = structuredClone(request)
  recognitionLeak.command.entry.confirmed_recognition_term = true
  assert.throws(() => assertManageRequest(recognitionLeak), /confirmed_recognition_term/)
})

test('SEM-F30/J21: overview exposes one bounded automatic scope directory for settings and Agent Bar selection', () => {
  const directory = fixtures.overviewScopeDirectory.response.snapshot.scope_directory
  assert.equal(directory.has_more, false)
  assert.deepEqual(directory.items.map((item) => item.kind), ['session', 'topic', 'project'])
  assert.equal(new Set(directory.items.map((item) => item.scope_id)).size, directory.items.length)
  assert.deepEqual(fixtures.overviewScopeEmpty.response.snapshot.scope_directory, {
    has_more: false,
    items: []
  })

  const rendererCreatedScope = structuredClone(fixtures.manageRememberProcessing.request)
  rendererCreatedScope.command.type = 'create_scope'
  assert.throws(() => assertManageRequest(rendererCreatedScope), /command.type/)
})

test('SEM-F30/J21: opaque pagination fixtures advance to a distinct second page without offset cursors', () => {
  const first = fixtures.manageViewPageOne
  const second = fixtures.manageViewPageTwo
  assert.equal(first.response.result.has_more, true)
  assert.equal(first.response.result.next_cursor, second.request.command.cursor)
  assert.notEqual(first.response.result.items[0].memory_id, second.response.result.items[0].memory_id)
  assert.equal(second.response.result.has_more, false)
  assert.equal(second.response.result.next_cursor, null)
  assert.doesNotMatch(first.response.result.next_cursor, /^offset_/)
})

test('SEM-F30/J21: conflict and public failure shapes are fixed and carry no scheduler diagnostics', () => {
  assert.deepEqual(ERROR_CODES, {
    notFound: 'AGENT_CONTEXT_NOT_FOUND',
    operationFailed: 'AGENT_CONTEXT_OPERATION_FAILED',
    permissionDenied: 'AGENT_CONTEXT_PERMISSION_DENIED',
    requestInvalid: 'AGENT_CONTEXT_REQUEST_INVALID',
    revisionConflict: 'AGENT_CONTEXT_REVISION_CONFLICT',
    unavailable: 'AGENT_CONTEXT_UNAVAILABLE'
  })

  const conflict = fixtures.manageRevisionConflict.response
  assert.equal(conflict.ok, false)
  assert.deepEqual(conflict.error, {
    category: 'conflict',
    code: ERROR_CODES.revisionConflict,
    current_revision: 8,
    next_action: 'reload',
    retry_policy: 'reload'
  })

  for (const name of ['manageRevisionConflict', 'managePermissionFailure', 'overviewUnavailable']) {
    const serialized = JSON.stringify(fixtures[name])
    assert.doesNotMatch(serialized, /AGENT_SCHEDULER_FAILED|wakeEpoch|generation|claim|lease|timer/i)
  }

  const wrongCategory = structuredClone(fixtures.manageRevisionConflict.response)
  wrongCategory.error.category = 'failure'
  assert.throws(() => assertManageResponse(wrongCategory), /category/)

  const unknownError = structuredClone(fixtures.manageOperationFailure.response)
  unknownError.error.code = 'AGENT_CONTEXT_UNKNOWN'
  assert.throws(() => assertManageResponse(unknownError), /code/)

  const wrongErrorType = structuredClone(fixtures.overviewUnavailable.response)
  wrongErrorType.error.current_revision = '0'
  assert.throws(() => assertGetOverviewResponse(wrongErrorType), /current_revision/)
})

test('SEM-F30/J21: forget and delete remain distinct result shapes', () => {
  const forgotten = fixtures.manageForgetResult.response
  assert.equal(forgotten.result.kind, 'memory_item')
  assert.equal(forgotten.result.operation, 'forget')
  assert.equal(forgotten.result.item.lifecycle, 'forgotten')
  assert.equal(forgotten.result.item.source_reference_count, 2)

  const deleted = fixtures.manageDeleteResult.response
  assert.equal(deleted.result.kind, 'deletion')
  assert.equal(deleted.result.replayed, false)
  assert.deepEqual(deleted.result.deleted, {
    evidence: 2,
    items: 1,
    revisions: 3
  })
})

test('SEM-F30/J21: version mismatch never falls through to a compatible-looking payload', () => {
  for (const [fixtureName, field] of [
    ['overviewEmpty', 'request'],
    ['overviewReady', 'response'],
    ['manageRememberProcessing', 'request'],
    ['manageDeleteResult', 'response'],
    ['changedReload', 'event']
  ]) {
    const payload = structuredClone(fixtures[fixtureName][field])
    payload.contract_version = '1.0.1'
    const validator = field === 'request'
      ? (fixtureName.startsWith('overview') ? assertGetOverviewRequest : assertManageRequest)
      : field === 'response'
        ? (fixtureName.startsWith('overview') ? assertGetOverviewResponse : assertManageResponse)
        : assertChangedEvent
    assert.throws(() => validator(payload), /contract_version/)
  }
})

test('SEM-F14/SEM-F30/J21: fixture privacy scan fails closed on credentials, audio, paths and sensitive diagnostics', () => {
  const mutations = [
    ['api_key', 'secret'],
    ['audio_path', 'synthetic.wav'],
    ['device_name', 'Synthetic Device'],
    ['local_path', 'C:\\Users\\Person\\context.json'],
    ['clock_offset_ms', 12],
    ['transcript_text', 'synthetic transcript body'],
    ['stack', 'Error: internal']
  ]

  for (const [key, value] of mutations) {
    const fixture = structuredClone(fixtures.overviewReady)
    fixture[key] = value
    assert.throws(() => assertFixturePrivacy(fixture), /privacy/)
  }

  const sensitiveTimestamp = structuredClone(fixtures.manageViewReady)
  sensitiveTimestamp.response.result.items[0].updated_at = '2026-08-30T12:34:56.000Z'
  assert.throws(() => assertFixturePrivacy(sensitiveTimestamp), /synthetic date/)
})
