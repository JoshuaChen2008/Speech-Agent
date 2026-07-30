'use strict'

// @ts-check

/* JSONL -> SQLite one-shot migration coordinator.
   -------------------------------------------------------------------------
   This main-process service is deliberately not wired into main.js yet. It
   reads the legacy files, reduces them to the narrow subtitle-fact payload
   accepted by the storage worker, then independently compares the old and
   new *original-text* projections. Legacy translations are counted only;
   they never cross this API boundary. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { assertCaptionEvent } = require('../../contracts')
const {
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  parseSessionText
} = require('./transcript-store')

const ORIGINAL_EVENT_NAMES = Object.freeze(new Set(['segment.final', 'segment.refined']))
const LEGACY_CAPTION_NAMES = Object.freeze({
  'segment.final': 'final',
  'segment.refined': 'refined'
})
const KNOWN_LEGACY_EVENTS = Object.freeze(new Set([
  'session.open',
  'session.close',
  'segment.partial',
  'segment.final',
  'segment.refined',
  'segment.translated'
]))

class LegacyMigrationError extends Error {
  constructor (code) {
    super(code === 'MIGRATION_DIGEST_MISMATCH'
      ? 'Legacy transcript migration verification failed.'
      : 'Legacy transcript file is invalid.')
    this.name = 'LegacyMigrationError'
    this.code = code
  }
}

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function exactMilliseconds (seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  const milliseconds = Math.round(seconds * 1000)
  /* SQLite stores integer milliseconds. Reject, rather than silently round,
     every legacy timestamp that cannot make an exact round trip. */
  if (!Number.isSafeInteger(milliseconds) || milliseconds / 1000 !== seconds) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  return milliseconds
}

function timestampFromIso (value) {
  if (typeof value !== 'string') throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  return timestamp
}

function sourceNameFor (filePath) {
  const sourceName = path.basename(filePath)
  if (sourceName.length === 0 || sourceName === '.' || sourceName === '..' || /[\\/\0]/.test(sourceName)) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  return sourceName
}

function sourceCaption (record, sessionId) {
  const kind = LEGACY_CAPTION_NAMES[record.event]
  if (!kind || record.sessionId !== sessionId) throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  const event = {
    schemaVersion: 1,
    sessionId,
    sourceId: record.sourceId,
    segmentId: record.segmentId,
    sequence: record.sequence,
    revision: record.revision,
    kind,
    t0: exactMilliseconds(record.t0) / 1000,
    t1: exactMilliseconds(record.t1) / 1000,
    text: record.text,
    translation: null
  }
  try {
    assertCaptionEvent(event)
  } catch {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  return event
}

function originalSegments (captions) {
  const events = captions.map((caption) => ({
    v: 1,
    event: `segment.${caption.kind}`,
    sessionId: caption.sessionId,
    sourceId: caption.sourceId,
    segmentId: caption.segmentId,
    sequence: caption.sequence,
    revision: caption.revision,
    t0: caption.t0,
    t1: caption.t1,
    text: caption.text
  }))
  return foldSegments(events).map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
    textRevision: segment.textRevision,
    t0: segment.t0,
    t1: segment.t1,
    translation: null
  }))
}

function legacyOriginalSegments (events) {
  return foldSegments(events.filter((record) => ORIGINAL_EVENT_NAMES.has(record.event)))
    .map((segment) => ({
      segmentId: segment.segmentId,
      sourceId: segment.sourceId,
      text: segment.text,
      textRevision: segment.textRevision,
      t0: segment.t0,
      t1: segment.t1,
      translation: null
    }))
}

function originalDigests (segments) {
  const currentTranscript = segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
    textRevision: segment.textRevision,
    t0: segment.t0,
    t1: segment.t1
  }))
  return Object.freeze({
    currentTranscript: sha256(JSON.stringify(currentTranscript)),
    text: sha256(exportText(segments)),
    markdown: sha256(exportMarkdown(segments)),
    srt: sha256(exportSrt(segments))
  })
}

function sqliteSegments (transcript) {
  if (!transcript || !Array.isArray(transcript.segments)) throw new LegacyMigrationError('MIGRATION_DIGEST_MISMATCH')
  return transcript.segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
    textRevision: segment.textRevision,
    t0: segment.t0Ms / 1000,
    t1: segment.t1Ms / 1000,
    translation: null
  }))
}

function assertSameDigests (legacy, sqlite) {
  for (const key of Object.keys(legacy)) {
    if (legacy[key] !== sqlite[key]) throw new LegacyMigrationError('MIGRATION_DIGEST_MISMATCH')
  }
}

function prepareLegacyBatch (events, report, options) {
  if (events.some((record) => !KNOWN_LEGACY_EVENTS.has(record.event))) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  /* TranscriptStore always writes one open first and, when present, one close
     last. Accepting records outside that lifetime would turn a corrupt file
     into a plausible but false session history. */
  if (events.length === 0 || events[0].event !== 'session.open') {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  const opens = events.filter((record) => record.event === 'session.open')
  if (opens.length !== 1 || typeof opens[0].sessionId !== 'string' || opens[0].sessionId.length === 0) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  const sessionId = opens[0].sessionId
  const startedAt = timestampFromIso(opens[0].at)
  const closes = events.filter((record) => record.event === 'session.close')
  if (closes.length > 1 || (closes[0] && closes[0].sessionId !== sessionId)) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  if (closes.length === 1 && events[events.length - 1] !== closes[0]) {
    throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }
  const closedAt = closes.length === 1 ? timestampFromIso(closes[0].at) : null
  if (closedAt !== null && closedAt < startedAt) throw new LegacyMigrationError('INVALID_LEGACY_FILE')

  const captions = events
    .filter((record) => ORIGINAL_EVENT_NAMES.has(record.event))
    .map((record) => sourceCaption(record, sessionId))
  const translatedEventCount = events.filter((record) => record.event === 'segment.translated').length
  const partialEventCount = events.filter((record) => record.event === 'segment.partial').length

  for (const record of events.filter((candidate) =>
    candidate.event === 'segment.translated' || candidate.event === 'segment.partial')) {
    if (record.sessionId !== sessionId) throw new LegacyMigrationError('INVALID_LEGACY_FILE')
  }

  /* A B3.1 archive does not put sourceId on session.open. An empty archive is
     therefore auditable but cannot truthfully create a SQLite XOR session. */
  let session = null
  if (captions.length > 0) {
    const sourceIds = new Set(captions.map((caption) => caption.sourceId))
    if (sourceIds.size !== 1) throw new LegacyMigrationError('INVALID_LEGACY_FILE')
    const sourceId = [...sourceIds][0]
    const missingClose = closes.length === 0
    const endedAt = missingClose
      ? Math.max(startedAt, startedAt + Math.max(...captions.map((caption) => exactMilliseconds(caption.t1))))
      : closedAt
    session = {
      sessionId,
      sourceId,
      startedAt,
      endedAt,
      state: missingClose ? 'interrupted' : 'closed'
    }
    for (const record of events.filter((candidate) =>
      candidate.event === 'segment.translated' || candidate.event === 'segment.partial')) {
      if (record.sourceId !== undefined && record.sourceId !== sourceId) {
        throw new LegacyMigrationError('INVALID_LEGACY_FILE')
      }
    }
  }

  return {
    sourceSha256: options.sourceSha256,
    sourceName: options.sourceName,
    importedAt: options.importedAt,
    sourceRecordCount: events.length,
    captionEventCount: captions.length,
    translatedEventCount,
    corruptLineCount: report.corruptLineCount,
    truncatedTail: report.truncatedTail,
    session,
    captions,
    partialEventCount
  }
}

class JsonlSqliteMigrator {
  constructor (options) {
    if (!options?.gateway || typeof options.gateway.importLegacyJsonl !== 'function' ||
        typeof options.gateway.getSessionTranscript !== 'function') {
      throw new TypeError('migration gateway is required')
    }
    this.gateway = options.gateway
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.readFile = options.readFile === undefined ? fs.readFileSync : options.readFile
    if (typeof this.readFile !== 'function') throw new TypeError('readFile must be a function')
  }

  async migrateFile (filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('legacy JSONL path must be absolute')
    }
    const sourceName = sourceNameFor(filePath)
    const snapshot = this.readFile(filePath)
    if (!Buffer.isBuffer(snapshot) && !(snapshot instanceof Uint8Array)) {
      throw new TypeError('readFile must return bytes')
    }
    const raw = Buffer.from(snapshot)
    const report = parseSessionText(raw.toString('utf8'))
    const importedAt = this.now()
    if (!Number.isSafeInteger(importedAt) || importedAt < 0) throw new TypeError('migration clock must return epoch milliseconds')
    const batch = prepareLegacyBatch(report.events, report, {
      sourceSha256: sha256(raw),
      sourceName,
      importedAt
    })
    /* Expected truth is folded independently from the immutable legacy text
       snapshot, not reconstructed from the worker payload. */
    const expectedSegments = legacyOriginalSegments(report.events)
    const expectedDigests = originalDigests(expectedSegments)
    const result = await this.gateway.importLegacyJsonl({
      sourceSha256: batch.sourceSha256,
      sourceName: batch.sourceName,
      importedAt: batch.importedAt,
      sourceRecordCount: batch.sourceRecordCount,
      captionEventCount: batch.captionEventCount,
      translatedEventCount: batch.translatedEventCount,
      corruptLineCount: batch.corruptLineCount,
      truncatedTail: batch.truncatedTail,
      session: batch.session,
      captions: batch.captions
    })

    let sqliteDigests = originalDigests([])
    if (batch.session) {
      const transcript = await this.gateway.getSessionTranscript(batch.session.sessionId)
      sqliteDigests = originalDigests(sqliteSegments(transcript))
    }
    assertSameDigests(expectedDigests, sqliteDigests)

    return Object.freeze({
      sourceName: batch.sourceName,
      sourceSha256: batch.sourceSha256,
      status: result.status,
      result: result.result,
      sessionId: batch.session?.sessionId || null,
      sessionState: batch.session?.state || 'skipped',
      sourceRecordCount: batch.sourceRecordCount,
      importedCaptionEventCount: batch.captionEventCount,
      translatedEventCount: batch.translatedEventCount,
      partialEventCount: batch.partialEventCount,
      corruptLineCount: batch.corruptLineCount,
      truncatedTail: batch.truncatedTail,
      digests: expectedDigests
    })
  }

  async migrateFiles (filePaths) {
    if (!Array.isArray(filePaths)) throw new TypeError('legacy JSONL paths must be an array')
    const reports = []
    for (const filePath of filePaths) reports.push(await this.migrateFile(filePath))
    return Object.freeze(reports)
  }

  migrateDirectory (directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new TypeError('legacy JSONL directory must be absolute')
    }
    if (!fs.existsSync(directory)) return Promise.resolve(Object.freeze([]))
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
      .map((entry) => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right))
    return this.migrateFiles(files)
  }
}

module.exports = {
  JsonlSqliteMigrator,
  LegacyMigrationError,
  legacyOriginalSegments,
  originalDigests,
  originalSegments,
  prepareLegacyBatch,
  sha256,
  sqliteSegments
}
