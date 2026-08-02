'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { parseStrictEvidenceJson } = require('../../scripts/strict-evidence-json')

test('parses a real tracked evidence report from a Buffer', () => {
  const reportPath = path.join(__dirname, '..', '..', 'docs', 'validation', 'storage-gateway-results.json')
  const bytes = fs.readFileSync(reportPath)

  assert.deepEqual(
    parseStrictEvidenceJson(bytes, reportPath),
    JSON.parse(bytes.toString('utf8'))
  )
})

test('parses every JSON value kind and produces ordinary JavaScript values', () => {
  const parsed = parseStrictEvidenceJson(
    '{"object":{"same":"key"},"array":["text",-12.5e2,true,false,null],"same":"allowed in another object","__proto__":{"safe":true}}',
    'all-values.json'
  )

  assert.deepEqual(parsed, JSON.parse(
    '{"object":{"same":"key"},"array":["text",-1250,true,false,null],"same":"allowed in another object","__proto__":{"safe":true}}'
  ))
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
  assert.equal(Object.hasOwn(parsed, '__proto__'), true)
})

test('rejects a duplicate key nested inside another object', () => {
  assert.throws(
    () => parseStrictEvidenceJson('{"outer":{"valid":1,"deeper":{"id":1,"id":2}}}', 'nested.json'),
    /nested\.json: duplicate object key "id"/
  )
})

test('rejects duplicate keys that are equivalent after escape decoding', () => {
  assert.throws(
    () => parseStrictEvidenceJson('{"label":"visible","la\\u0062el":"hidden"}', 'escaped-key.json'),
    /duplicate object key "label"/
  )
})

test('rejects paths hidden in the first occurrence of a duplicate evidence key', () => {
  const hiddenPaths = [
    ['Windows', 'C:\\Users\\Alice\\recording.wav'],
    ['UNC', '\\\\server\\share\\recording.wav'],
    ['POSIX', '/var/tmp/recording.wav'],
    ['audio', 'D:\\evidence\\audio\\meeting.flac']
  ]

  for (const [kind, hiddenPath] of hiddenPaths) {
    const source = `{"artifact":${JSON.stringify(hiddenPath)},"artifact":"approved.json"}`
    assert.throws(
      () => parseStrictEvidenceJson(source, `${kind}-path.json`),
      /duplicate object key "artifact"/,
      kind
    )
  }
})

test('rejects a duplicate key in an object contained by an array', () => {
  assert.throws(
    () => parseStrictEvidenceJson('[{"id":1},{"path":"first.wav","path":"second.wav"}]', 'array.json'),
    /duplicate object key "path"/
  )
})

test('rejects UTF-8 BOMs and malformed UTF-8 bytes', () => {
  assert.throws(
    () => parseStrictEvidenceJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'bom-buffer.json'),
    /UTF-8 BOM is not allowed/
  )
  assert.throws(
    () => parseStrictEvidenceJson('\ufeff{}', 'bom-string.json'),
    /UTF-8 BOM is not allowed/
  )
  assert.throws(
    () => parseStrictEvidenceJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), 'bad-utf8.json'),
    /bad-utf8\.json: invalid UTF-8 input/
  )
})

test('rejects trailing input and multiple JSON roots', () => {
  assert.throws(
    () => parseStrictEvidenceJson('{"ok":true} hidden', 'trailing.json'),
    /trailing input after the JSON value/
  )
  assert.throws(
    () => parseStrictEvidenceJson('{} []', 'two-roots.json'),
    /trailing input after the JSON value/
  )
})

test('rejects illegal string syntax and invalid number forms', () => {
  assert.throws(
    () => parseStrictEvidenceJson('{"value":"bad\\q"}', 'escape.json'),
    /invalid escape in string/
  )
  assert.throws(
    () => parseStrictEvidenceJson('{"value":"line\nfeed"}', 'control.json'),
    /unescaped control character in string/
  )
  assert.throws(
    () => parseStrictEvidenceJson('01', 'leading-zero.json'),
    /leading zero is not allowed/
  )
  assert.throws(
    () => parseStrictEvidenceJson('1e400', 'overflow.json'),
    /overflow\.json: non-finite number 1e400/
  )
})

test('tracked validation JSON contains no transcript body or audio filename', () => {
  const validationRoot = path.resolve(__dirname, '../../docs/validation')
  const files = []
  const visitDirectory = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visitDirectory(target)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target)
    }
  }
  const forbiddenTextKeys = /^(?:captionText|hypothesis|joinedFinalText|joinedRefinedText|reference|text|transcript|transcriptText|wav)$/i
  const forbiddenLocationKeys = /^(?:audioFile|audioFilePath|audioPath|deviceLabel|deviceName|localPath|modelPath)$/i
  const inspect = (value, label) => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) inspect(value[index], `${label}[${index}]`)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const childLabel = `${label}.${key}`
      if (typeof child === 'string' && forbiddenTextKeys.test(key)) {
        assert.fail(`${childLabel} persists transcript text or an audio filename`)
      }
      if (forbiddenLocationKeys.test(key)) assert.fail(`${childLabel} persists a forbidden location or device field`)
      if (key === 'tokens' && Array.isArray(child) && child.some((item) => typeof item === 'string')) {
        assert.fail(`${childLabel} persists reconstructable transcript tokens`)
      }
      inspect(child, childLabel)
    }
  }

  visitDirectory(validationRoot)
  assert.ok(files.length > 0)
  for (const file of files) {
    const bytes = fs.readFileSync(file)
    const relative = path.relative(validationRoot, file)
    if (/\.(?:flac|m4a|mp3|ogg|opus|pcm|wav)(?:["'?#\\/]|$)/i.test(bytes.toString('utf8'))) {
      assert.fail(`${relative} contains an audio filename or extension`)
    }
    inspect(parseStrictEvidenceJson(bytes, relative), relative)
  }
})
