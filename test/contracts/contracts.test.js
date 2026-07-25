'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CAPTION_KINDS,
  RUNTIME_PHASES,
  assertCapabilities,
  assertCaptionEvent,
  assertCommandResult,
  assertRuntimeSnapshot,
  isCapabilities,
  isCaptionEvent,
  isCommandResult,
  isRuntimeSnapshot
} = require('../../src/contracts')
const fixtures = require('../../src/contracts/fixtures')

const runtimeFixtures = Object.values(fixtures.runtime)
const captionFixtures = Object.values(fixtures.captions)
const commandFixtures = Object.values(fixtures.commands)
const capabilityFixtures = Object.values(fixtures.capabilities)

test('all v1 fixtures pass their runtime validators', () => {
  runtimeFixtures.forEach((fixture) => assert.equal(assertRuntimeSnapshot(fixture), fixture))
  captionFixtures.forEach((fixture) => assert.equal(assertCaptionEvent(fixture), fixture))
  commandFixtures.forEach((fixture) => assert.equal(assertCommandResult(fixture), fixture))
  capabilityFixtures.forEach((fixture) => assert.equal(assertCapabilities(fixture), fixture))
})

test('runtime fixtures cover every phase plus pause/resume continuity', () => {
  assert.deepEqual(
    [...new Set(runtimeFixtures.map((fixture) => fixture.phase))].sort(),
    [...RUNTIME_PHASES].sort()
  )

  const revisions = runtimeFixtures.map((fixture) => fixture.revision)
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
  assert.equal(new Set(revisions).size, revisions.length)
  assert.equal(fixtures.runtime.paused.sessionId, fixtures.runtime.resumed.sessionId)
  assert.ok(fixtures.runtime.resumed.revision > fixtures.runtime.paused.revision)
  assert.equal(fixtures.runtime.resumed.phase, 'listening')
})

test('runtime fixtures expose state-appropriate transition capabilities', () => {
  assert.equal(fixtures.runtime.idle.capabilities.canStart, true)
  assert.equal(fixtures.runtime.listening.capabilities.canPause, true)
  assert.equal(fixtures.runtime.listening.capabilities.canStop, true)
  assert.equal(fixtures.runtime.paused.capabilities.canResume, true)
  assert.equal(fixtures.runtime.paused.capabilities.canStop, true)
  assert.equal(fixtures.runtime.error.capabilities.canRetry, true)

  for (const name of ['starting', 'stopping', 'recovering']) {
    const capabilities = fixtures.runtime[name].capabilities
    assert.equal(capabilities.canStart, false)
    assert.equal(capabilities.canPause, false)
    assert.equal(capabilities.canResume, false)
    assert.equal(capabilities.canStop, false)
    assert.equal(capabilities.canRetry, false)
  }
})

test('caption fixtures form one ordered partial/final/refined/translated segment', () => {
  assert.deepEqual(captionFixtures.map((fixture) => fixture.kind), CAPTION_KINDS)

  for (const field of ['sessionId', 'sourceId', 'segmentId']) {
    assert.equal(new Set(captionFixtures.map((fixture) => fixture[field])).size, 1)
  }

  for (let index = 1; index < captionFixtures.length; index += 1) {
    assert.ok(captionFixtures[index].sequence > captionFixtures[index - 1].sequence)
    assert.ok(captionFixtures[index].revision > captionFixtures[index - 1].revision)
  }

  assert.notEqual(fixtures.captions.refined.text, fixtures.captions.final.text)
  assert.equal(
    fixtures.captions.translated.translation.basedOnRevision,
    fixtures.captions.refined.revision
  )
})

test('CommandResult is a discriminated success/failure contract', () => {
  assert.equal(fixtures.commands.startOk.ok, true)
  assert.equal(fixtures.commands.startOk.code, 'OK')
  for (const fixture of commandFixtures.filter((value) => !value.ok)) {
    assert.notEqual(fixture.code, 'OK')
    assert.equal(typeof fixture.message, 'string')
    assert.equal(typeof fixture.recoverable, 'boolean')
  }
})

test('validators ignore unknown fields for forward compatibility', () => {
  const runtime = structuredClone(fixtures.runtime.idle)
  runtime.futureRuntimeField = { enabled: true }
  runtime.sources[0].futureSourceField = 7
  assert.doesNotThrow(() => assertRuntimeSnapshot(runtime))

  const caption = { ...structuredClone(fixtures.captions.final), futureCaptionField: 'v2' }
  assert.doesNotThrow(() => assertCaptionEvent(caption))
})

test('validators reject invalid versions, ranges, enums, order, and discriminants', () => {
  const wrongVersion = structuredClone(fixtures.runtime.idle)
  wrongVersion.schemaVersion = 2
  assert.throws(() => assertRuntimeSnapshot(wrongVersion), /schemaVersion/)

  const badPhase = structuredClone(fixtures.runtime.idle)
  badPhase.phase = 'recording'
  assert.throws(() => assertRuntimeSnapshot(badPhase), /phase/)

  const badLevel = structuredClone(fixtures.runtime.listening)
  badLevel.sources[0].level = Number.POSITIVE_INFINITY
  assert.throws(() => assertRuntimeSnapshot(badLevel), /level/)

  const duplicateProfile = structuredClone(fixtures.capabilities.full)
  duplicateProfile.availableProfiles.push('balanced')
  assert.throws(() => assertCapabilities(duplicateProfile), /duplicates/)

  const invalidLanguage = structuredClone(fixtures.capabilities.full)
  invalidLanguage.translationTargets = ['invalid language!']
  assert.throws(() => assertCapabilities(invalidLanguage), /translationTargets/)

  const idleCanPause = structuredClone(fixtures.runtime.idle)
  idleCanPause.capabilities.canPause = true
  assert.throws(() => assertRuntimeSnapshot(idleCanPause), /canPause/)

  const pausedActiveSource = structuredClone(fixtures.runtime.paused)
  pausedActiveSource.sources[0].state = 'active'
  pausedActiveSource.sources[0].level = 0.2
  assert.throws(() => assertRuntimeSnapshot(pausedActiveSource), /sources\[0\]\.state/)

  const listeningWithoutActiveSource = structuredClone(fixtures.runtime.listening)
  listeningWithoutActiveSource.sources.forEach((source) => {
    source.state = 'inactive'
    source.level = 0
  })
  assert.throws(() => assertRuntimeSnapshot(listeningWithoutActiveSource), /source in state active/)

  const backwardsTime = structuredClone(fixtures.captions.final)
  backwardsTime.t1 = backwardsTime.t0 - 0.01
  assert.throws(() => assertCaptionEvent(backwardsTime), /t1/)

  const staleTranslation = structuredClone(fixtures.captions.translated)
  staleTranslation.translation.basedOnRevision = staleTranslation.revision
  assert.throws(() => assertCaptionEvent(staleTranslation), /basedOnRevision/)

  const incompleteFailure = structuredClone(fixtures.commands.modelNotReady)
  delete incompleteFailure.message
  assert.throws(() => assertCommandResult(incompleteFailure), /message/)
})

test('boolean validators return false instead of throwing', () => {
  assert.equal(isRuntimeSnapshot({}), false)
  assert.equal(isCaptionEvent({}), false)
  assert.equal(isCommandResult({}), false)
  assert.equal(isCapabilities({}), false)
})

test('fixture exports are deeply frozen', () => {
  assert.equal(Object.isFrozen(fixtures), true)
  assert.equal(Object.isFrozen(fixtures.runtime.listening.capabilities), true)
  assert.equal(Object.isFrozen(fixtures.captions.translated.translation), true)
})

test('fixtures contain no credentials, model paths, or machine-specific paths', () => {
  const serialized = JSON.stringify(fixtures)
  const forbidden = [
    /api[-_]?key/i,
    /authorization/i,
    /bearer\s/i,
    /\.onnx/i,
    /[A-Z]:\\/i,
    /(?:^|[\\/])Users[\\/]/i
  ]
  forbidden.forEach((pattern) => assert.doesNotMatch(serialized, pattern))
})
