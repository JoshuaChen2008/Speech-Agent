'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { LANE_DIRECTORIES, selectFiles, runFiles, runAll } = require('../../scripts/run-test-lanes')

function fixture (t, failingLane) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lanes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of Object.values(LANE_DIRECTORIES).flat()) {
    fs.mkdirSync(path.join(root, 'test', directory), { recursive: true })
  }
  for (const [lane, directories] of Object.entries(LANE_DIRECTORIES)) {
    fs.writeFileSync(path.join(root, 'test', directories[0], 'behavior.test.js'), `
      const test = require('node:test')
      const fs = require('node:fs')
      test('runner child ${lane}', () => {
        fs.appendFileSync('executed.txt', '${lane}\\n')
        ${lane === failingLane ? "throw new Error('deliberate runner failure')" : ''}
      })
    `)
  }
  return root
}

test('SEM-T03/J9-CI explicit file selection rejects empty, unknown, outside and directory requests', (t) => {
  const root = fixture(t)
  assert.throws(() => selectFiles([], root), /at least one/)
  for (const file of ['test/contracts', '../outside.test.js', 'test/unknown/x.test.js',
    'test/contracts/missing.test.js', '--watch', 'test/**/*.test.js']) {
    assert.throws(() => selectFiles([file], root))
  }
  assert.deepEqual(selectFiles(['test/contracts/behavior.test.js', 'test/contracts/behavior.test.js'], root),
    ['test/contracts/behavior.test.js'])
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/run-test-lanes.js'), 'focus'],
    { encoding: 'utf8', windowsHide: true })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /at least one/)
})

test('SEM-T03/J9-CI focused tests run once without unrelated lanes or renderer preparation', (t) => {
  const root = fixture(t)
  assert.equal(runFiles(['test/contracts/behavior.test.js', 'test/contracts/behavior.test.js'],
    { root, stdio: 'pipe' }), 0)
  assert.equal(fs.readFileSync(path.join(root, 'executed.txt'), 'utf8'), 'core\n')
})

test('SEM-T03/J9-CI full runner executes each lane once and propagates child failure', (t) => {
  const success = fixture(t)
  assert.equal(runAll({ root: success, stdio: 'pipe' }), 0)
  assert.equal(fs.readFileSync(path.join(success, 'executed.txt'), 'utf8'), 'core\nintegration\nevidence\n')
  const failure = fixture(t, 'integration')
  assert.equal(runAll({ root: failure, stdio: 'pipe' }), 1)
  assert.equal(fs.readFileSync(path.join(failure, 'executed.txt'), 'utf8'), 'core\nintegration\n')
})
