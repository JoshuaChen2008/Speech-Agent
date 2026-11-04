'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { qualifyPiCore } = require('../../scripts/fixtures/pi-core-qualification')

test('SEM-F28/F33/J22/J24: locked Pi core qualifies request, tool, turn and cancellation boundaries without implicit retry', async () => {
  assert.deepEqual(await qualifyPiCore(), { requests: 2, tools: 2, turns: 2, peakTools: 1,
    cancelledTools: 1, cancelledRequests: 1, failedRequests: 1 })
})
