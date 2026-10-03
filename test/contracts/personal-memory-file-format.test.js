'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseFile, renderFile } = require('../../src/agent/personal-context/memory-file-format')

test('SEM-F41/J28-FILES: byte and consumed revisions separate while unknown YAML, comments, BOM and line endings survive', () => {
  const bytes = Buffer.from('\uFEFF---\r\nid: memory.one # owned ID\r\nkind: project_fact\r\nscope: {kind: global, reference: null}\r\ncustom: {color: blue}\r\n# keep this comment\r\n---\r\n项目计划\r\n')
  const first = parseFile(bytes)
  assert.deepEqual(renderFile(first.id, first.entry, first), bytes)
  const comment = parseFile(Buffer.from(bytes.toString().replace('blue', 'red')))
  assert.notEqual(comment.byteHash, first.byteHash); assert.equal(comment.contentHash, first.contentHash)
  const edited = renderFile(first.id, { ...first.entry, kind: 'decision', display_text: '项目决定' }, first)
  assert.match(edited.toString(), /custom: \{color: blue\}/); assert.match(edited.toString(), /# keep this comment/)
  assert.equal(edited.toString().startsWith('\uFEFF'), true)
  assert.equal(parseFile(edited).entry.kind, 'decision')
})

test('SEM-F41/SEM-T04/J28-FILES: malformed UTF8, duplicate keys, aliases, unbounded body and invalid scope fail closed', () => {
  const valid = renderFile('memory.one', { kind: 'project_fact', scope: { kind: 'global', reference: null }, display_text: '合成记忆' })
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from(valid.toString().replace('kind: project_fact', 'kind: project_fact\nkind: preference')), Buffer.from(valid.toString().replace('scope:', 'x: &a {key: value}\nscope: *a\nx2:')), Buffer.from(valid.toString().replace('合成记忆', '长'.repeat(1000))), Buffer.from(valid.toString().replace('"reference":null', '"reference":"session.one"'))]) assert.throws(() => parseFile(bytes))
  const plain = parseFile(Buffer.from('只是外部笔记'))
  assert.equal(plain.id, null); assert.equal(plain.entry, null)
})
