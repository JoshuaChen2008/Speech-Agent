'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const packageJson = require('../../package.json')

const LANE_DIRECTORIES = {
  core: ['contracts', 'main', 'runtime', 'storage', 'ui'],
  integration: ['integration'],
  evidence: ['gate-0b', 'gate-0c', 'validation']
}

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
  assert.equal(scripts.test, 'npm run test:core && npm run test:integration && npm run test:evidence')
})

test('CI full regression delegates to the complete test command without replaying integration', () => {
  const scripts = packageJson.scripts
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const packagedJourney = workflow.indexOf('node scripts/qualify-nsis-lifecycle.js')
  const regression = workflow.indexOf('run: npm run test:ci')

  assert.equal(scripts['test:ci'], 'npm test')
  assert.doesNotMatch(scripts['test:ci'], /test:integration/)
  assert.equal(workflow.match(/run: npm run test:ci/g)?.length, 1)
  assert.doesNotMatch(workflow, /npm run test:integration/)
  assert.ok(regression > packagedJourney,
    'the full regression remains after packaged and NSIS journey qualification')
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
