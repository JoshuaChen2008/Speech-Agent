'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { qualify } = require('../../scripts/nls-native-fallback-qualification')
test('SEM-F14/F21/F25 J20 explicit native fallback qualification; hosted CI does not claim local model evidence', {
  skip: process.env.RUN_NLS_NATIVE_QUALIFICATION !== '1' ? 'explicit native qualification not requested; no model evidence claimed' : false
}, async () => {
  const report = await qualify() // Opted-in missing assets fail, never silently skip.
  assert.equal(report.realNativeRecognition, true)
  assert.equal(report.realCloud, false)
  assert.equal(report.realCapture, false)
  assert.equal(report.cases.length, 2)
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:[\\/]|"text"|"samples"|"device"/)
})
