'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  FORMAL_AGENT_MIGRATIONS,
  MODEL_ACCESS_SCHEMA_SQL
} = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function databasePath (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-access-v6-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'speech-agent.sqlite3')
}

test('SEM-F33/DB7/J25: formal v5 upgrades by appending byte-stable migrations v6 and v7', (t) => {
  const file = databasePath(t)
  const frozen = FORMAL_AGENT_MIGRATIONS.slice(0, 5).map(({ version, checksum, sql }) => ({ version, checksum, sql }))
  const v5 = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 5) })
  v5.close()
  const v6 = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS })
  assert.equal(v6.database.prepare('PRAGMA user_version').get().user_version, 7)
  assert.deepEqual(FORMAL_AGENT_MIGRATIONS.slice(0, 5).map(({ version, checksum, sql }) => ({ version, checksum, sql })), frozen)
  const tables = v6.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_model_%' ORDER BY name").all().map(({ name }) => name)
  assert.deepEqual(tables, [
    'agent_model_profile_models', 'agent_model_profiles',
    'agent_model_purpose_assignments', 'agent_model_run_bindings'
  ])
  v6.close()
})

test('SEM-F33/DB7/J25: v6 seeds only the DeepSeek provider template and four empty purposes', (t) => {
  const store = new SqliteSubtitleStore({ databasePath: databasePath(t), migrations: FORMAL_AGENT_MIGRATIONS })
  const profile = store.database.prepare('SELECT * FROM agent_model_profiles').get()
  assert.equal(profile.profile_id, 'deepseek')
  assert.equal(profile.template_id, 'deepseek-openai-template@1')
  assert.equal(profile.https_origin, 'https://api.deepseek.com')
  assert.equal(profile.base_path, '/')
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM agent_model_profile_models').get().count, 0)
  const purposes = store.database.prepare('SELECT purpose, profile_id, model_id, configuration_revision FROM agent_model_purpose_assignments ORDER BY purpose').all()
  assert.equal(purposes.length, 4)
  assert.equal(purposes.every((row) => row.profile_id === null && row.model_id === null && row.configuration_revision === 0), true)
  store.close()
})

test('SEM-F14/SEM-F33/DB7/J25: v6 schema contains no sensitive, transcript, audio, path, or pricing fields', () => {
  assert.doesNotMatch(MODEL_ACCESS_SCHEMA_SQL, /\b(api_key|authorization|header|audio|pcm|wav|device_name|local_path|absolute_path|transcript_text|caption_text|raw_error|stack)\b/i)
  assert.doesNotMatch(MODEL_ACCESS_SCHEMA_SQL, /\b(price|cost|currency|pricing)\w*\b/i)
})

test('SEM-F33/DB7/J25: capability insert and update both fail closed on non-exact JSON', (t) => {
  const store = new SqliteSubtitleStore({ databasePath: databasePath(t), migrations: FORMAL_AGENT_MIGRATIONS })
  store.database.prepare(`INSERT INTO agent_model_profile_models(
    profile_id,model_id,capability_json,created_at,updated_at
  ) VALUES('deepseek','exact-model',?,1,1)`).run(JSON.stringify({
    maxInputTokens: 10, maxOutputTokens: 5, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true
  }))
  assert.throws(() => store.database.prepare("UPDATE agent_model_profile_models SET capability_json=? WHERE profile_id='deepseek' AND model_id='exact-model'").run(JSON.stringify({
    maxInputTokens: 10, maxOutputTokens: 5, supportsToolCalling: 1,
    supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true
  })), /invalid model capability/)
  store.close()
})
