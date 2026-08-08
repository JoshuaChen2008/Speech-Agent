'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

test('SEM-F23/J18: toolbar semantic icons resolve to pinned Fluent System Icons assets', () => {
  const entry = fs.readFileSync(path.join(root, 'src', 'toolbar', 'entry.ts'), 'utf8')
  const source = fs.readFileSync(path.join(root, 'src', 'ui', 'shared', 'fluent-icons.ts'), 'utf8')
  assert.match(entry, /ui\/shared\/fluent-icons\.ts/)
  assert.doesNotMatch(source, /<path|<circle|<rect|<polygon/)
  assert.match(source, /fill="currentColor"/)

  const assetPaths = [...source.matchAll(/from '(@fluentui\/svg-icons\/icons\/[^']+\.svg\?raw)'/g)]
    .map((match) => match[1].replace('@fluentui/svg-icons/', '').replace('?raw', ''))
  assert.equal(assetPaths.length, 18)
  for (const assetPath of assetPaths) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '@fluentui', 'svg-icons', assetPath)), true,
      `${assetPath} must exist in the locked Fluent System Icons package`)
  }

  for (const semanticName of [
    'ban', 'ready', 'spinner', 'wave', 'pause', 'stopping', 'recover', 'alert',
    'play', 'stop', 'retry', 'settings', 'model', 'permission', 'grip', 'history',
    'lock', 'unlock', 'close'
  ]) {
    assert.match(source, new RegExp(`\\b${semanticName}(?:\\s*:|,)`))
  }
})
