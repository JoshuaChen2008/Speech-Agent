'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { buildSummary, overallResult, parseArguments, run, runVerifiedStage, stage } = require('../../scripts/unattended-qualification')
const { requireUnattendedSchema, scanOutputDirectory, validateUnattendedSummary } = require('../../scripts/verify-unattended-qualification')

test('SEM-F21/I2/I3 unattended arguments require fresh workspace-local inputs', () => {
  const parsed = parseArguments(['--output', '.artifacts/unattended-new', '--model-user-data', '.artifacts/models'])
  assert.ok(parsed.output.endsWith(path.join('.artifacts', 'unattended-new')))
  assert.throws(() => parseArguments([]), /--output is required/)
  assert.throws(() => parseArguments(['--output', '..\\outside']), /project workspace/)
})

test('unattended stage classifies timeout, non-zero exit and missing evidence without retry', () => {
  const missing = path.join(os.tmpdir(), `missing-${process.pid}.json`)
  assert.deepEqual(runVerifiedStage({ id: 'deterministic', command: 'node', args: [], report: missing, runner: () => ({ status: 'failed', code: 'stage-timeout' }) }),
    stage('deterministic', 'failed', 'stage-timeout'))
  assert.deepEqual(runVerifiedStage({ id: 'deterministic', command: 'node', args: [], report: missing, runner: () => ({ status: 'failed', code: 'child-nonzero' }) }),
    stage('deterministic', 'failed', 'child-nonzero'))
  assert.deepEqual(runVerifiedStage({ id: 'deterministic', command: 'node', args: [], report: missing, runner: () => ({ status: 'pass', code: 'ok' }) }),
    stage('deterministic', 'failed', 'report-missing'))

  const report = path.join(os.tmpdir(), `unattended-report-${process.pid}.json`)
  fs.writeFileSync(report, '{}')
  assert.deepEqual(runVerifiedStage({ id: 'deterministic', command: 'node', args: [], report, verify: () => { throw new Error('rejected') }, runner: () => ({ status: 'pass', code: 'ok' }) }),
    stage('deterministic', 'failed', 'report-rejected'))
  assert.equal(fs.existsSync(report), false, 'a classified failure removes its stage artifact from the fresh output')
})

test('strict unattended summary preserves dependency skips and rejects privacy drift', () => {
  const stages = [
    stage('preflight', 'blocked', 'model-bundle-missing'),
    stage('deterministic', 'pass', 'ok', 'a'.repeat(64)),
    stage('i3-qualification', 'skipped', 'dependency-not-passed'),
    stage('i2-series', 'skipped', 'dependency-not-passed')
  ]
  assert.equal(overallResult(stages), 'blocked')
  const summary = buildSummary(stages, new Date('2026-09-20T00:00:00.000Z'))
  assert.deepEqual(validateUnattendedSummary(summary), summary)
  const leaked = structuredClone(summary)
  leaked.stages[0].deviceName = 'speaker'
  assert.throws(() => validateUnattendedSummary(leaked), /unexpected keys|forbidden/)
  const tampered = structuredClone(summary)
  tampered.candidate.runnerSha256 = '0'.repeat(63)
  assert.throws(() => validateUnattendedSummary(tampered))

  const impossible = structuredClone(summary)
  impossible.stages[0] = stage('preflight', 'blocked', 'model-bundle-missing')
  impossible.stages[2] = stage('i3-qualification', 'pass', 'ok', 'b'.repeat(64))
  impossible.stages[3] = stage('i2-series', 'pass', 'ok', 'c'.repeat(64))
  impossible.result = 'blocked'
  assert.throws(() => validateUnattendedSummary(impossible), /dependency-not-passed/)
})

test('fresh output is exclusive and duplicate creation is rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-output-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'candidate')
  fs.mkdirSync(target)
  assert.throws(() => run({ output: target, modelUserData: path.join(root, 'models'), preflightOnly: true }), /fresh directory/)
})

test('unattended qualification rejects historical schemas and unexpected audio output', (t) => {
  assert.throws(() => requireUnattendedSchema({ schemaVersion: 1 }, 2, 'I3 qualification'), /schema 2/)
  assert.throws(() => requireUnattendedSchema({ schemaVersion: 5 }, 6, 'I2 child'), /schema 6/)
  assert.throws(() => requireUnattendedSchema({ schemaVersion: 6 }, 7, 'I2 series'), /schema 7/)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-scan-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'summary.json'), '{}')
  scanOutputDirectory(directory)
  fs.writeFileSync(path.join(directory, 'capture.wav'), '')
  assert.throws(() => scanOutputDirectory(directory), /contains audio/)
})
