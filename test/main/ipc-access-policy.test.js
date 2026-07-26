'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const CHANNELS = require('../../src/main/ipc/channels')
const {
  ROLE_ACCESS,
  assertRendererConfigPatch,
  changesCaptureConfiguration,
  isRoleAllowed
} = require('../../src/main/ipc/access-policy')

test('every inbound channel has an explicit least-privilege role allowlist', () => {
  const inbound = Object.values(CHANNELS).filter((channel) => ![
    CHANNELS.LOCK_CHANGED,
    CHANNELS.CONFIG_CHANGED,
    CHANNELS.RUNTIME_CHANGED,
    CHANNELS.CAPTION_EVENT
  ].includes(channel))
  assert.deepEqual(Object.keys(ROLE_ACCESS).sort(), inbound.sort())
})

test('window roles cannot invoke one another privileged APIs', () => {
  assert.equal(isRoleAllowed(CHANNELS.RUNTIME_COMMAND, 'toolbar'), true)
  assert.equal(isRoleAllowed(CHANNELS.RUNTIME_COMMAND, 'caption'), false)
  assert.equal(isRoleAllowed(CHANNELS.RUNTIME_GET, 'toolbar'), true)
  assert.equal(isRoleAllowed(CHANNELS.RUNTIME_GET, 'settings'), true)
  assert.equal(isRoleAllowed(CHANNELS.RUNTIME_GET, 'caption'), false)
  assert.equal(isRoleAllowed(CHANNELS.CONFIG_UPDATE, 'settings'), true)
  assert.equal(isRoleAllowed(CHANNELS.CONFIG_UPDATE, 'toolbar'), false)
  assert.equal(isRoleAllowed(CHANNELS.RESIZE_START, 'caption'), true)
  assert.equal(isRoleAllowed(CHANNELS.RESIZE_START, 'settings'), false)
  assert.equal(isRoleAllowed(CHANNELS.SETTINGS_CLOSE, 'settings'), true)
  assert.equal(isRoleAllowed(CHANNELS.SETTINGS_CLOSE, 'toolbar'), false)
})

test('renderer config writes are whitelisted and capture changes are classified', () => {
  assert.doesNotThrow(() => assertRendererConfigPatch({ opacity: 0.5, theme: 'dark' }))
  assert.throws(() => assertRendererConfigPatch({ schemaVersion: 1 }), /not renderer-writable/)
  assert.throws(() => assertRendererConfigPatch({ onboardingCompleted: true }), /not renderer-writable/)
  assert.throws(() => assertRendererConfigPatch(null), /object/)
  assert.equal(changesCaptureConfiguration({ mic: true }), true)
  assert.equal(changesCaptureConfiguration({ opacity: 0.5 }), false)
})
