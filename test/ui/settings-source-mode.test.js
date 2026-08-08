'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

test('settings expose one XOR listening-mode choice and no independent source toggles', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings-view.tsx'), 'utf8')
  const script = html

  assert.match(html, /id="audioSourceChoice"[^>]+role="radiogroup"/)
  assert.match(html, /\['loopback', 'meeting', '系统音频'\]/)
  assert.match(html, /\['mic', 'dictation', '麦克风'\]/)
  assert.match(html, /data-source=\{source\} data-preset=\{preset\} role="radio"/)
  assert.doesNotMatch(html, /data-toggle="(?:mic|loopback)"/)
  assert.match(script, /shell\.selectPreset\(preset\)/)
  assert.match(script, /disabled=\{sessionActive \|\| sourcePending\}/)
})
