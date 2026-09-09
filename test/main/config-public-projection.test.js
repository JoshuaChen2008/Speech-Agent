'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { publicConfigPayload } = require('../../src/main/config-public-projection')

test('generic renderer config projection omits automatic processing boundaries', () => {
  const projected = publicConfigPayload({
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: true,
    agentSettingsRevision: 4,
    automaticProcessingSince: { sessionId: 'private-session', eventOrder: 9 },
    memoryProcessingSince: { sessionId: 'private-memory-session', eventOrder: 11 }
  })

  assert.deepEqual(projected, {
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: true,
    agentSettingsRevision: 4
  })
  assert.equal(Object.hasOwn(projected, 'automaticProcessingSince'), false)
  assert.equal(Object.hasOwn(projected, 'memoryProcessingSince'), false)
})

test('generic renderer config projection does not mutate its input', () => {
  const source = {
    automaticProcessingSince: { sessionId: 'private-session' },
    agentEnabled: false
  }
  const projected = publicConfigPayload(source)

  assert.deepEqual(source, {
    automaticProcessingSince: { sessionId: 'private-session' },
    agentEnabled: false
  })
  assert.deepEqual(projected, { agentEnabled: false })
})
