'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createPersonalContextModule } = require('../../src/agent/personal-context')
const { PersonalContextController } = require('../../src/agent/personal-context/controller')
const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')
const { ConfigStore } = require('../../src/main/services/config-store')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function setup (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-controller-'))
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'context.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now: () => 946684800000
  })
  const store = new PersonalContextStore({ subtitleStore, now: () => 946684800000 })
  const module = createPersonalContextModule({
    storage: {
      personalContextIngest: async (source) => store.ingest(source),
      personalContextResolve: async (request) => store.resolve(request),
      personalContextManage: async (command) => store.manage(command)
    }
  })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 946684800000 })
  config.load()
  const changes = []
  const controller = new PersonalContextController({
    module,
    readScopeDirectory: async (command) => store.manage(command),
    getConfig: () => config.get(),
    updateAgentSettings: (request) => config.updateAgentSettings(request),
    onChanged: options.throwObserver
      ? () => { throw new Error('observer failure') }
      : (event) => changes.push(event)
  })
  t.after(() => {
    subtitleStore.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { changes, config, controller, store, subtitleStore }
}

function request (requestId, command) {
  return { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, request_id: requestId, command }
}

function entry (displayText = 'Explicit memory') {
  return {
    display_text: displayText,
    kind: 'term',
    scope: { kind: 'global', reference: null }
  }
}

test('SEM-F30/J21: controller projects empty overview and composite revision through frozen UI contract', async (t) => {
  const { controller } = setup(t)
  const response = await controller.getOverview({ contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION })
  assert.equal(response.ok, true)
  assert.deepEqual(response.snapshot.counts, { personal_memories: 0, session_episodes: 0 })
  assert.equal(response.snapshot.revision, 0)
  assert.equal(response.snapshot.eligibility, 'provider_not_configured')
  assert.deepEqual(response.snapshot.scope_directory, { has_more: false, items: [] })
})

test('SEM-F30/J21: remember, update and forget expose exact projections and one changed event per revision', async (t) => {
  const { changes, controller } = setup(t)
  const remembered = await controller.manage(request('remember.1', {
    type: 'remember', expected_revision: 0, entry: entry('Use North Star')
  }))
  assert.equal(remembered.ok, true)
  assert.equal(remembered.revision, 1)
  assert.equal(remembered.result.item.revision, 1)
  assert.match(remembered.result.item.memory_id, /^memory\./)

  const updated = await controller.manage(request('update.1', {
    type: 'update', expected_revision: 1,
    item_id: remembered.result.item.memory_id, item_revision: 1,
    entry: entry('Use Polaris')
  }))
  assert.equal(updated.result.item.memory_id, remembered.result.item.memory_id)
  const forgotten = await controller.manage(request('forget.1', {
    type: 'forget', expected_revision: 2,
    item_id: remembered.result.item.memory_id, item_revision: updated.result.item.revision
  }))
  assert.equal(forgotten.result.item.lifecycle, 'forgotten')
  assert.deepEqual(changes.map((event) => event.revision), [1, 2, 3])

  const page = await controller.manage(request('view.1', {
    type: 'view', resource: 'personal_memories', limit: 20, cursor: null
  }))
  assert.equal(page.result.items[0].revision, 3)
  assert.equal(page.revision, 3)
})

test('SEM-F30/J21: composite revision conflict performs zero SQLite and ConfigStore writes', async (t) => {
  const { config, controller, store } = setup(t)
  const response = await controller.manage(request('conflict.1', {
    type: 'remember', expected_revision: 9, entry: entry('Conflict key')
  }))
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'AGENT_CONTEXT_REVISION_CONFLICT')
  assert.equal(response.error.current_revision, 0)
  assert.equal(store.contentRevision(), 0)
  assert.equal(config.get().agentSettingsRevision, 0)
})

test('SEM-F30/J21: processing preserves other settings, no-op stays silent, and observer failure is isolated', async (t) => {
  const { config, controller, store } = setup(t, { throwObserver: true })
  const suspended = await controller.manage(request('processing.1', {
    type: 'set_processing', expected_revision: 0, state: 'suspended'
  }))
  assert.equal(suspended.ok, true)
  assert.equal(suspended.revision, 1)
  assert.deepEqual(suspended.result.memory_processing, {
    state: 'suspended', automatic_processing_boundary: 'not_established'
  })
  assert.deepEqual({
    agentEnabled: config.get().agentEnabled,
    memoryEnabled: config.get().memoryEnabled,
    cloudDisclosureAccepted: config.get().cloudDisclosureAccepted
  }, { agentEnabled: false, memoryEnabled: false, cloudDisclosureAccepted: false })
  assert.equal(store.contentRevision(), 0)

  const noOp = await controller.manage(request('processing.2', {
    type: 'set_processing', expected_revision: 1, state: 'suspended'
  }))
  assert.equal(noOp.ok, true)
  assert.equal(noOp.revision, 1)
  assert.equal(config.get().agentSettingsRevision, 1)
})

test('SEM-F30/J21: delete replay returns original counts at current composite revision without rebroadcast', async (t) => {
  const { changes, controller } = setup(t)
  const remembered = await controller.manage(request('remember.delete', {
    type: 'remember', expected_revision: 0, entry: entry('Delete key')
  }))
  const command = {
    type: 'delete', expected_revision: 1,
    item_id: remembered.result.item.memory_id, item_revision: 1,
    deletion_idempotency_key: 'delete.key.1'
  }
  const deleted = await controller.manage(request('delete.1', command))
  const replayed = await controller.manage(request('delete.2', command))
  assert.equal(deleted.ok, true)
  assert.equal(deleted.result.replayed, false)
  assert.equal(replayed.ok, true)
  assert.equal(replayed.result.replayed, true)
  assert.deepEqual(replayed.result.deleted, deleted.result.deleted)
  assert.equal(replayed.revision, 2)
  assert.deepEqual(changes.map((event) => event.revision), [1, 2])
})

test('SEM-F30/J21: controller consumes opaque keyset cursor and caller limit for distinct pages', async (t) => {
  const { controller } = setup(t)
  for (const [index, displayText] of ['Alpha memory', 'Beta memory', 'Gamma memory'].entries()) {
    const response = await controller.manage(request(`remember.page.${index}`, {
      type: 'remember', expected_revision: index, entry: entry(displayText)
    }))
    assert.equal(response.ok, true)
  }

  const first = await controller.manage(request('view.page.1', {
    type: 'view', resource: 'personal_memories', limit: 1, cursor: null
  }))
  const second = await controller.manage(request('view.page.2', {
    type: 'view', resource: 'personal_memories', limit: 1, cursor: first.result.next_cursor
  }))
  assert.equal(first.result.items.length, 1)
  assert.equal(second.result.items.length, 1)
  assert.notEqual(first.result.items[0].memory_id, second.result.items[0].memory_id)
  assert.doesNotMatch(first.result.next_cursor, /^offset_/)
})

test('SEM-F30/J21: malformed and unsupported operations fail closed without raw exception details', async (t) => {
  const { controller } = setup(t)
  const invalid = await controller.manage({ contract_id: CONTRACT_ID, contract_version: '2.0.0' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'AGENT_CONTEXT_REQUEST_INVALID')
  assert.doesNotMatch(JSON.stringify(invalid), /TypeError|stack|sqlite/i)
})
