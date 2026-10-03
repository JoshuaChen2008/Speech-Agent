'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { assertRecognitionProgress, assertRecognitionMetadata, NLS_PARAMETERS } = require('../../src/contracts/recognition')
const { assertRuntimeSnapshot } = require('../../src/contracts/runtime-snapshot')
const fixtures = require('../../src/contracts/fixtures')

test('SEM-F06/F14/F21/J20 local fallback progress is a closed transient projection outside persisted metadata', () => {
  for (const phase of ['loading', 'replaying', 'local']) assertRecognitionProgress({ sessionId: 'session', phase })
  for (const value of [{ sessionId: '', phase: 'loading' }, { sessionId: 'session', phase: 'ready' },
    { sessionId: 'session', phase: 'loading', text: 'not permitted' }]) assert.throws(() => assertRecognitionProgress(value))
  const metadata = { resultStatus: 'known', binding: { strategy: 'cloud-primary', provider: 'nls',
    region: 'cn-shanghai', configRevision: 1, projectRef: 'a'.repeat(64), modelLabel: '', parameters: NLS_PARAMETERS },
    actualProvider: 'nls', fallbackCode: null, fallbackAtMs: null, faultCode: null, faultAtMs: null }
  assertRecognitionMetadata(metadata)
  assert.throws(() => assertRecognitionMetadata({ ...metadata, recognitionProgress: { sessionId: 'session', phase: 'loading' } }))
  const snapshot = { ...structuredClone(fixtures.runtime.listening), recognition: metadata }
  for (const phase of ['loading', 'replaying', 'local']) {
    const recognition = phase === 'loading' ? metadata : { ...metadata, actualProvider: 'local',
      fallbackCode: 'NLS_CONNECTION_CLOSED', fallbackAtMs: 0 }
    assertRuntimeSnapshot({ ...snapshot, recognition, recognitionProgress: { sessionId: snapshot.sessionId, phase } })
  }
  for (const recognitionProgress of [{ sessionId: 'other', phase: 'loading' },
    { sessionId: snapshot.sessionId, phase: 'replaying' }, { sessionId: snapshot.sessionId, phase: 'local' }]) {
    assert.throws(() => assertRuntimeSnapshot({ ...snapshot, recognitionProgress }))
  }
  assert.throws(() => assertRuntimeSnapshot({ ...structuredClone(fixtures.runtime.paused), recognition: metadata,
    recognitionProgress: { sessionId: fixtures.runtime.paused.sessionId, phase: 'loading' } }))
})
