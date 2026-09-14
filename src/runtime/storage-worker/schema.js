'use strict'
// Historical SQL is byte-stable; daily readers only need this catalog.
const history = require('./historical-migrations')
const { RETIREMENT_SQL } = require('./retirement-migration')
const FORMAL_AGENT_MIGRATIONS = Object.freeze([
  ...history.FORMAL_AGENT_MIGRATIONS,
  Object.freeze({ version: 10, sql: RETIREMENT_SQL, checksum: history.checksum(RETIREMENT_SQL) })
])
module.exports = { ...history, FORMAL_AGENT_MIGRATIONS, FORMAL_AGENT_SCHEMA_VERSION: 10 }
