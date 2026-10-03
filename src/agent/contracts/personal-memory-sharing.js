'use strict'

const { assertExactKeys } = require('../../runtime/storage-worker/protocol')
const fail = () => { throw Object.assign(new TypeError('MEMORY_FILE_SHARING_INVALID'), { code: 'MEMORY_FILE_SHARING_INVALID' }) }
function id (value) { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) fail() }
function assertSharingSelection (ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length) fail()
  ids.forEach(id)
}
function assertSharingScope (scope) {
  if (scope === null) return
  assertExactKeys(scope, ['kind', 'reference'])
  if (!['global', 'session', 'project', 'topic'].includes(scope.kind)) fail()
  if (scope.kind === 'global') { if (scope.reference !== null) fail() } else id(scope.reference)
}
function assertSharingCommand (c) {
  const fields = { contentList: ['scope', 'after'], contentPreview: ['memoryIds'], contentCopy: ['memoryIds', 'digest', 'format'],
    contentExport: ['memoryIds', 'digest', 'format'], mcpStart: ['memoryIds', 'digest'], mcpStop: [], mcpStatus: [], mcpCopyConfig: [] }
  if (!c || !Object.hasOwn(fields, c.type)) fail()
  assertExactKeys(c, ['type', ...fields[c.type]])
  if ('memoryIds' in c) assertSharingSelection(c.memoryIds)
  if ('digest' in c && (typeof c.digest !== 'string' || !/^[a-f0-9]{64}$/.test(c.digest))) fail()
  if ('format' in c && !['markdown', 'json'].includes(c.format)) fail()
  if (c.type === 'contentList') { assertSharingScope(c.scope); if (c.after !== null) id(c.after) }
  return c
}
module.exports = { assertSharingSelection, assertSharingScope, assertSharingCommand }
