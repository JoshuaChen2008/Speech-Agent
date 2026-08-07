'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createTwoStageRecognizerAdapter,
  requireTwoStageRecognizerConfiguration
} = require('../../src/runtime/realtime-worker/recognizer-adapter')

function scriptedAdapter (options = {}) {
  const calls = []
  const polls = [...(options.polls || [])]
  return {
    calls,
    acceptFrame (samples, timestampSeconds) {
      calls.push(['accept', samples, timestampSeconds])
      if (options.failAccept) throw new Error('private draft accept failure')
    },
    poll () {
      calls.push(['poll'])
      if (options.failPoll) throw new Error('private draft poll failure')
      return polls.length > 0 ? polls.shift() : null
    },
    endSegment () {
      calls.push(['end'])
      if (options.failEnd) throw new Error('private draft end failure')
      return options.final || null
    },
    discardProvisional () { calls.push(['discard']) },
    dispose () { calls.push(['dispose']) }
  }
}

test('SEM-F21/J16 publishes Partial Caption until the Authoritative Recognizer owns the segment', () => {
  const draft = scriptedAdapter({ polls: ['临时一', '临时二', '不得回写'], final: '不得定稿' })
  const authoritative = scriptedAdapter({ polls: [null, '权威临时', null], final: '首次稳定转写' })
  const adapter = createTwoStageRecognizerAdapter({
    createDraft: () => draft,
    createAuthoritative: () => authoritative
  })
  const frame = new Float32Array(1600)

  adapter.acceptFrame(frame, 0)
  assert.equal(adapter.poll(), '临时一')
  adapter.acceptFrame(frame, 0.1)
  assert.equal(adapter.poll(), '权威临时')
  adapter.acceptFrame(frame, 0.2)
  assert.equal(adapter.poll(), null, 'Draft Recognizer cannot write back after Authoritative Recognizer takeover')
  assert.equal(adapter.endSegment(), '首次稳定转写')
  const draftFrames = draft.calls.filter(([name]) => name === 'accept')
  const authoritativeFrames = authoritative.calls.filter(([name]) => name === 'accept')
  assert.equal(draftFrames.length, 3)
  assert.equal(authoritativeFrames.length, 3)
  for (let index = 0; index < 3; index += 1) {
    assert.equal(draftFrames[index][1], frame)
    assert.equal(authoritativeFrames[index][1], frame)
    assert.equal(draftFrames[index][2], index / 10)
    assert.equal(authoritativeFrames[index][2], index / 10)
  }
})

test('SEM-F21/J16 fails closed with the frozen start code when the Draft Recognizer cannot be constructed', () => {
  assert.throws(() => createTwoStageRecognizerAdapter({
    createDraft: () => { throw new Error('C:\\private\\draft-model') },
    createAuthoritative: () => scriptedAdapter()
  }), (error) => {
    assert.equal(error.code, 'DRAFT_RECOGNIZER_START_FAILED')
    assert.doesNotMatch(error.message, /private|model/i)
    return true
  })

  for (const invalidDraft of [null, {}]) {
    assert.throws(() => createTwoStageRecognizerAdapter({
      createDraft: () => invalidDraft,
      createAuthoritative: () => scriptedAdapter()
    }), (error) => error.code === 'DRAFT_RECOGNIZER_START_FAILED')
  }
})

test('SEM-F21/J16 requires both recognizer roles before a real worker can configure', () => {
  const authoritative = { role: 'authoritative' }
  const draft = { role: 'temporary-caption' }
  assert.deepEqual(requireTwoStageRecognizerConfiguration(authoritative, draft), {
    recognizer: authoritative,
    draftRecognizer: draft
  })
  assert.throws(
    () => requireTwoStageRecognizerConfiguration(authoritative, null),
    (error) => error.code === 'DRAFT_RECOGNIZER_START_FAILED' && !/null|object/.test(error.message)
  )
  assert.throws(
    () => requireTwoStageRecognizerConfiguration(null, draft),
    /authoritative recognizer configuration is required/
  )
})

test('SEM-F21/J16 releases a valid Draft Recognizer when Authoritative Recognizer construction is invalid', () => {
  for (const invalidAuthoritative of [null, {}]) {
    const draft = scriptedAdapter()
    assert.throws(() => createTwoStageRecognizerAdapter({
      createDraft: () => draft,
      createAuthoritative: () => invalidAuthoritative
    }), /authoritative recognizer adapter is invalid/)
    assert.equal(draft.calls.filter(([name]) => name === 'dispose').length, 1)
  }
})

test('SEM-F21/J16 degrades once on a Draft Recognizer runtime failure and keeps the First-pass Final', () => {
  const faults = []
  const draft = scriptedAdapter({ failPoll: true })
  const authoritative = scriptedAdapter({ polls: [null, '权威临时'], final: '权威定稿' })
  const adapter = createTwoStageRecognizerAdapter({
    createDraft: () => draft,
    createAuthoritative: () => authoritative,
    onDraftFault: (fault) => faults.push(fault)
  })
  const frame = new Float32Array(800)

  adapter.acceptFrame(frame, 0)
  assert.equal(adapter.poll(), null)
  adapter.acceptFrame(frame, 0.05)
  assert.equal(adapter.poll(), '权威临时')
  assert.equal(adapter.endSegment(), '权威定稿')
  assert.deepEqual(faults, [{ code: 'DRAFT_RECOGNIZER_FAILED', stage: 'poll', count: 1 }])
  assert.equal(draft.calls.filter(([name]) => name === 'dispose').length, 1)
})

test('SEM-F21/J16 propagates Authoritative Recognizer failures and releases both streams once', () => {
  const draft = scriptedAdapter()
  const authoritative = scriptedAdapter({ failAccept: true })
  const adapter = createTwoStageRecognizerAdapter({
    createDraft: () => draft,
    createAuthoritative: () => authoritative
  })

  assert.throws(() => adapter.acceptFrame(new Float32Array(400), 0), /authoritative|accept failure/)
  adapter.dispose()
  adapter.dispose()
  assert.equal(draft.calls.filter(([name]) => name === 'dispose').length, 1)
  assert.equal(authoritative.calls.filter(([name]) => name === 'dispose').length, 1)
})
