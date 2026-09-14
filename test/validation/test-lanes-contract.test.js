'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const packageJson = require('../../package.json')
const { LANE_DIRECTORIES, laneFiles } = require('../../scripts/run-test-lanes')

function commandFor (directories) {
  const files = directories.map((directory) => `\"test/${directory}/**/*.test.js\"`).join(' ')
  return `node --test --experimental-test-isolation=none ${files}`
}

test('test scripts partition every non-interactive test directory into core, integration, and evidence lanes', () => {
  const scripts = packageJson.scripts
  const testRootEntries = fs.readdirSync(path.join(ROOT, 'test'), { withFileTypes: true })
  const testDirectories = testRootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const unassignedRootTests = testRootEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort()
  const declaredDirectories = Object.values(LANE_DIRECTORIES).flat().sort()

  assert.deepEqual(unassignedRootTests, [],
    'test/*.test.js is outside every lane; place it in one declared test directory')
  assert.deepEqual(testDirectories, declaredDirectories,
    'every test directory must be assigned to exactly one non-interactive lane')
  assert.equal(scripts['test:core'], commandFor(LANE_DIRECTORIES.core))
  assert.equal(scripts['test:integration'], commandFor(LANE_DIRECTORIES.integration))
  assert.equal(scripts['test:evidence'], commandFor(LANE_DIRECTORIES.evidence))
  assert.equal(scripts.test, 'node scripts/run-test-lanes.js all')
  const files = Object.keys(LANE_DIRECTORIES).flatMap((lane) => laneFiles(lane))
  assert.equal(new Set(files).size, files.length, 'each test file runs in exactly one lane')
})

test('CI full regression delegates to the complete test command without replaying integration', () => {
  const scripts = packageJson.scripts
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const packagedJourney = workflow.indexOf('node scripts/qualify-nsis-lifecycle.js')
  const regression = workflow.indexOf('run: npm run test:ci')

  assert.equal(scripts['test:ci'], scripts.test)
  assert.equal(scripts.pretest, 'npm run verify:renderer')
  assert.equal(scripts['pretest:ci'], undefined)
  assert.equal(scripts['pretest:focus'], undefined)
  assert.equal(workflow.match(/run: npm run pretest\s/g)?.length, 1)
  assert.ok(workflow.indexOf('run: npm run pretest') < workflow.indexOf('scripts/caption-layout-smoke.js'))
  assert.doesNotMatch(workflow, /npm run verify:renderer|npm run package:(?:smoke|release)\s/)
  for (const variant of ['smoke', 'release']) {
    assert.equal(scripts[`prepackage:${variant}:prepared`], undefined)
    assert.equal(scripts[`prepackage:${variant}`], 'npm run verify:renderer')
    assert.match(workflow, new RegExp(`npm run package:${variant}:prepared`))
  }
  assert.doesNotMatch(scripts['test:ci'], /test:integration/)
  assert.equal(workflow.match(/run: npm run test:ci/g)?.length, 1)
  assert.doesNotMatch(workflow, /npm run test:integration/)
  assert.ok(regression > packagedJourney,
    'the full regression remains after packaged and NSIS journey qualification')
})

test('SEM-T03/J9-CI runs PR and main/tag qualification without duplicate feature push workflows', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /push:\s+branches: \[main\]\s+tags: \['\*\*'\]/)
  assert.match(workflow, /\n  pull_request:/)
  assert.match(workflow, /\n  workflow_dispatch:/)
  assert.doesNotMatch(workflow, /paths-ignore:|paths:/)
  assert.match(workflow, /cancel-in-progress: true/)
})

test('SEM-T03/J9-CI pins the exact-byte Gate 0B hash chain to LF', () => {
  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
  const requiredRules = [
    'scripts/gate-0b/corpus.json text eol=lf',
    'scripts/gate-0b/realtime-candidates.json text eol=lf',
    'docs/validation/gate-0b-realtime-candidate-summary.json text eol=lf'
  ]

  for (const rule of requiredRules) {
    assert.equal(attributes.split(/\r?\n/).includes(rule), true, `missing exact LF rule: ${rule}`)
  }
})
