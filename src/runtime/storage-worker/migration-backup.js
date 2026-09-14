'use strict'
// Private snapshots never leave the database directory. No body/path is logged.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { StorageError } = require('./protocol')
const quote = name => '"' + name.replaceAll('"', '""') + '"'
function inspectVersion(database, catalog) {
  const version = Number(database.prepare('PRAGMA user_version').get().user_version)
  const hasHistory = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get()
  const rows = hasHistory ? database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() : []
  const hasTables = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()
  if ((!hasHistory && hasTables) || version !== rows.length || version > catalog.length ||
      rows.some((row, i) => row.version !== i + 1 || row.checksum !== catalog[i]?.checksum)) {
    throw new StorageError('SCHEMA_IDENTITY_INVALID')
  }
  return version
}
function digest(database) {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify(database.prepare('PRAGMA user_version').get()))
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  hash.update(JSON.stringify(schema))
  for (const {name,type} of schema) {
    if (type !== 'table') continue
    const columns = database.prepare('PRAGMA table_info(' + quote(name) + ')').all()
    const order = columns.map(c => quote(c.name)).join(',')
    const query = database.prepare('SELECT * FROM ' + quote(name) + ' ORDER BY ' + order)
    query.setReadBigInts(true)
    let count = 0
    for (const row of query.iterate()) { hash.update(JSON.stringify(row, (_,v) => typeof v === 'bigint' ? {integer:String(v)} : v)); hash.update('\n'); count++ }
    hash.update(name + ':' + count + '\n')
  }
  return hash.digest('hex')
}
function verify(database) {
  if (database.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') ||
      database.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('snapshot validation failed')
}
function ensurePrivateDirectory (directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  // mkdir's mode is ignored when the directory already exists. Re-apply it on
  // every migration attempt so a previously relaxed backup directory is not
  // silently reused. Windows does not expose POSIX mode bits reliably.
  try { fs.chmodSync(directory, 0o700) } catch (error) {
    if (process.platform !== 'win32') throw error
  }
  if (process.platform === 'win32') {
    const whoami = spawnSync('whoami', { encoding: 'utf8', windowsHide: true })
    const account = whoami.status === 0 && typeof whoami.stdout === 'string' && whoami.stdout.trim().length > 0
      ? whoami.stdout.trim()
      : (process.env.USERNAME && process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME)
    if (!account) throw new Error('current Windows account is unavailable')
    const result = spawnSync('icacls', [
      directory,
      '/inheritance:r',
      '/grant:r', `${account}:(OI)(CI)F`,
      '/grant:r', 'SYSTEM:(OI)(CI)F'
    ], { stdio: 'ignore', windowsHide: true })
    if (result.error || result.status !== 0) throw result.error || new Error('private ACL setup failed')
    return
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(directory).mode & 0o777
    if ((mode & 0o077) !== 0) throw new Error('backup directory is not private')
  }
}
function removeCandidate (backupPath) {
  if (!backupPath) return
  try { fs.unlinkSync(backupPath) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
function createVerifiedBackup(database, databasePath, catalog, hooks = {}) {
  let backupPath
  try {
    hooks.create?.()
    const directory = path.join(path.dirname(databasePath), 'migration-backups')
    ensurePrivateDirectory(directory)
    backupPath = path.join(directory, 'before-retirement-' + crypto.randomUUID() + '.sqlite3')
    // Reserve exclusively; SQLite accepts an empty destination and never copies an active file.
    fs.closeSync(fs.openSync(backupPath, 'wx', 0o600))
    hooks.vacuum?.(backupPath)
    database.prepare('VACUUM INTO ?').run(backupPath)
  } catch {
    try { removeCandidate(backupPath) } catch { /* best effort cleanup */ }
    throw new StorageError('RETIREMENT_BACKUP_CREATE_FAILED')
  }
  let backup
  let verified = false
  try {
    hooks.verify?.()
    backup = new DatabaseSync(backupPath, { readOnly: true })
    verify(backup)
    if (inspectVersion(database,catalog) !== inspectVersion(backup,catalog) || digest(database) !== digest(backup)) throw new Error('snapshot identity differs')
    verified = true
  } catch {
    throw new StorageError('RETIREMENT_BACKUP_VERIFY_FAILED')
  } finally {
    if (backup) backup.close()
    if (!verified) {
      try { removeCandidate(backupPath) } catch { /* best effort cleanup */ }
    }
  }
  return backupPath
}
module.exports = { inspectVersion, createVerifiedBackup, ensurePrivateDirectory }
