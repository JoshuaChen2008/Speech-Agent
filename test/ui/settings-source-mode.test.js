'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

test('settings expose one XOR listening-mode choice and no independent source toggles', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8')
  const script = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.js'), 'utf8')

  assert.match(html, /id="audioSourceChoice"[^>]+role="radiogroup"/)
  assert.match(html, /data-source="loopback"[^>]+data-preset="meeting"[^>]+role="radio"/)
  assert.match(html, /data-source="mic"[^>]+data-preset="dictation"[^>]+role="radio"/)
  assert.doesNotMatch(html, /data-toggle="(?:mic|loopback)"/)
  assert.match(script, /window\.shell\.selectPreset\(button\.dataset\.preset\)/)
  assert.match(script, /button\.disabled = snapshot\.sessionId !== null/)
})
