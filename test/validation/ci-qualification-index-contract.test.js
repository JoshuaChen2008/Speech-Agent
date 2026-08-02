'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  readAndValidateCiQualificationIndex,
  validateCiQualificationIndex
} = require('../../scripts/verify-ci-qualification-index')
const {
  createCiQualificationIndex
} = require('../../scripts/write-ci-qualification-index')

const ROOT = path.resolve(__dirname, '../..')
const REVISION = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

function validIndex () {
  return {
    schema: 'ci-qualification-index@v1',
    generatedAt: '2026-08-02T08:00:00.000Z',
    result: 'pass',
    gateStatus: 'deterministic-ci-qualified',
    source: {
      actualRevision: REVISION,
      expectedRevision: REVISION,
      exactRevisionMatched: true,
      trackedWorktreeClean: true,
      packageLockSha256: SHA256,
      workflowSha256: 'c'.repeat(64)
    },
    run: {
      repository: 'example/live-subtitle',
      workflow: 'CI',
      job: 'windows-user-journeys',
      event: 'pull_request',
      runId: '123456789',
      runAttempt: 2
    },
    evidence: {
      captionLayoutReportSha256: 'd'.repeat(64),
      packagedRunBindingSha256: 'e'.repeat(64),
      releaseLayoutReportSha256: 'f'.repeat(64),
      nsisLifecycleReportSha256: '1'.repeat(64),
      installerSha256: '2'.repeat(64)
    },
    boundaries: {
      remoteArtifactOriginRequiresGitHubContext: true,
      provesCleanMachine: false,
      provesDwm: false,
      provesPhysicalAudio: false,
      provesSigning: false
    }
  }
}

test('CI qualification index accepts one exact checkout/run/evidence binding', () => {
  assert.deepEqual(validateCiQualificationIndex(validIndex()), validIndex())
})

test('CI qualification writer derives hashes only for the exact expected clean revision', () => {
  const fixturePath = path.join(ROOT, 'package-lock.json')
  const options = {
    expectedRevision: REVISION,
    runId: '123456789',
    runAttempt: 1,
    eventName: 'push',
    repository: 'example/live-subtitle',
    workflowName: 'CI',
    jobName: 'windows-user-journeys',
    packageLock: fixturePath,
    workflowFile: fixturePath,
    captionLayoutReport: fixturePath,
    packagedBindingReport: fixturePath,
    releaseLayoutReport: fixturePath,
    nsisLifecycleReport: fixturePath,
    installer: fixturePath
  }
  const index = createCiQualificationIndex(
    options,
    { actualRevision: REVISION, trackedWorktreeClean: true },
    '2026-08-02T08:00:00.000Z'
  )
  assert.equal(index.source.actualRevision, REVISION)
  assert.equal(index.source.packageLockSha256, index.evidence.installerSha256)

  assert.throws(() => createCiQualificationIndex(
    options,
    { actualRevision: '3'.repeat(40), trackedWorktreeClean: true }
  ), /does not match/i)
  assert.throws(() => createCiQualificationIndex(
    options,
    { actualRevision: REVISION, trackedWorktreeClean: false }
  ), /worktree/i)
})

test('CI qualification index fails closed on revision drift or tracked source mutation', () => {
  const mismatch = validIndex()
  mismatch.source.expectedRevision = '3'.repeat(40)
  assert.throws(() => validateCiQualificationIndex(mismatch), /revision/i)

  const dirty = validIndex()
  dirty.source.trackedWorktreeClean = false
  assert.throws(() => validateCiQualificationIndex(dirty), /worktree/i)
})

test('CI qualification index rejects unknown fields, weak identities and overclaimed boundaries', () => {
  const unknown = validIndex()
  unknown.source.branch = 'main'
  assert.throws(() => validateCiQualificationIndex(unknown), /keys/i)

  const weak = validIndex()
  weak.run.runId = 'local-run'
  assert.throws(() => validateCiQualificationIndex(weak), /runId/i)

  const overclaim = validIndex()
  overclaim.boundaries.provesDwm = true
  assert.throws(() => validateCiQualificationIndex(overclaim), /provesDwm/i)
})

test('CI qualification index strict reader rejects duplicate JSON keys and local/audio references', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-index-contract-'))
  const reportPath = path.join(temp, 'index.json')
  try {
    const valid = JSON.stringify(validIndex())
    fs.writeFileSync(reportPath, valid.replace('{', '{"schema":"duplicate",'))
    assert.throws(() => readAndValidateCiQualificationIndex(reportPath), /duplicate object key/i)

    const leaked = validIndex()
    leaked.run.workflow = 'capture.wav'
    assert.throws(() => validateCiQualificationIndex(leaked), /local address|audio reference/i)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('Windows CI writes and verifies provenance only after the full regression and before upload', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const regression = workflow.indexOf('run: npm run test:ci')
  const writeIndex = workflow.indexOf('node scripts/write-ci-qualification-index.js')
  const verifyIndex = workflow.indexOf('node scripts/verify-ci-qualification-index.js')
  const upload = workflow.indexOf('uses: actions/upload-artifact@v4')

  assert.ok(regression >= 0 && writeIndex > regression && verifyIndex > writeIndex && upload > verifyIndex)
  for (const token of [
    '$env:GITHUB_SHA', '$env:GITHUB_RUN_ID', '$env:GITHUB_RUN_ATTEMPT',
    '$env:GITHUB_EVENT_NAME', '$env:GITHUB_REPOSITORY', '$env:GITHUB_WORKFLOW'
  ]) assert.match(workflow, new RegExp(token.replaceAll('$', '\\$')))
})

test('SEM-T03 and J9-CI register exact revision provenance without overclaiming remote trust', () => {
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const semT03 = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-T03**'))
  const j9Ci = strategy.split(/\r?\n/).find((line) => line.includes('| J9-CI |'))

  assert.match(semT03, /checkout revision/)
  assert.match(semT03, /run ID\/attempt/)
  assert.match(semT03, /不带签名/)
  assert.match(j9Ci, /exact checkout revision/)
  assert.match(j9Ci, /尚未提交\/推送/)
})
