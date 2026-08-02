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

test('CI qualification lockfile and workflow provenance are pinned to LF checkout bytes', () => {
  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
  for (const relativePath of ['package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(attributes.includes(`${relativePath} text eol=lf`), true,
      `${relativePath} must be pinned to LF before its exact SHA is compared across checkouts`)
  }
})

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

test('Windows CI installs and verifies the locked Electron runtime before every dependent step', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const installDependencies = workflow.indexOf('run: npm ci')
  const installRuntime = workflow.indexOf('run: npm run electron:install')
  const verifyRuntime = workflow.indexOf("$electronPath = Join-Path $PWD 'node_modules/electron/dist/electron.exe'")

  assert.equal(packageJson.scripts['electron:install'], 'install-electron')
  assert.ok(installDependencies >= 0 && installRuntime > installDependencies)
  assert.ok(verifyRuntime > installRuntime)
  assert.match(workflow, /Test-Path -LiteralPath \$electronPath -PathType Leaf/)
  assert.match(workflow, /require\('\.\/package\.json'\)\.devDependencies\.electron/)
  assert.match(workflow, /require\('\.\/package-lock\.json'\)\.packages\['node_modules\/electron'\]\.version/)
  assert.match(workflow, /Start-Process -FilePath \$electronPath[\s\S]*-ArgumentList @\('--version'\)/)
  assert.match(workflow, /-RedirectStandardOutput \$versionStdout/)
  assert.match(workflow, /-RedirectStandardError \$versionStderr/)
  assert.match(workflow, /"v\$packageVersion"/)

  for (const dependent of [
    'scripts/caption-layout-smoke.js',
    'scripts/db0-sqlite-smoke.js',
    'scripts/db1-storage-smoke.js',
    'scripts/storage-gateway-smoke.js',
    'scripts/product-shell-smoke.js',
    'npm run package:smoke',
    'node scripts/run-packaged-product-shell.js',
    'npm run package:release',
    'node scripts/qualify-nsis-lifecycle.js',
    'run: npm run test:ci'
  ]) {
    const position = workflow.indexOf(dependent)
    assert.ok(position > verifyRuntime,
      `Electron runtime verification must precede ${dependent}`)
  }
})

test('SEM-T03 and J9-CI retain failed revisions, record the successful artifact, and freeze deterministic prerequisites', () => {
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const semT03 = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-T03**'))
  const j9Ci = strategy.split(/\r?\n/).find((line) => line.includes('| J9-CI |'))

  assert.match(semT03, /checkout revision/)
  assert.match(semT03, /run ID\/attempt/)
  assert.match(semT03, /不带签名/)
  assert.match(semT03, /electron\.exe/)
  assert.match(semT03, /30750568366/)
  assert.match(semT03, /30760407160/)
  assert.match(semT03, /30761472817/)
  assert.match(semT03, /30763123116/)
  assert.match(semT03, /30764235663/)
  assert.match(semT03, /30765231206/)
  assert.match(semT03, /30766172580/)
  assert.match(semT03, /2df032ffb1c4d7f3da3130cce240b617559947f8b4cef0c63d8cf8b0ca33698c/)
  assert.match(semT03, /33bddcb065f5297ab9b244c60455dda798d5415abab1b213d0c1fac65a537017/)
  assert.match(semT03, /hidden files/)
  assert.match(semT03, /受控模型就绪证明 fixture/)
  assert.match(semT03, /固定 LF/)
  assert.match(semT03, /完整产品载荷/)
  assert.match(semT03, /`package-lock\.json`\/workflow/)
  assert.match(semT03, /精确字节/)
  assert.match(semT03, /独立 Node child/)
  assert.match(semT03, /时区固定为 UTC/)
  assert.match(semT03, /产品导出的时间仍跟随运行它的 Windows 系统时区/)
  assert.match(j9Ci, /exact checkout revision/)
  assert.match(j9Ci, /30764235663/)
  assert.match(j9Ci, /30765231206/)
  assert.match(j9Ci, /30766172580/)
  assert.match(j9Ci, /2df032ffb1c4d7f3da3130cce240b617559947f8b4cef0c63d8cf8b0ca33698c/)
  assert.match(j9Ci, /33bddcb065f5297ab9b244c60455dda798d5415abab1b213d0c1fac65a537017/)
  assert.match(j9Ci, /Electron `43\.2\.0`/)
  assert.match(j9Ci, /受控模型就绪证明 fixture/)
  assert.match(j9Ci, /固定 LF/)
  assert.match(j9Ci, /全部产品文本 checkout.*固定 LF/)
  assert.match(j9Ci, /caption layout runner\/verifier/)
  assert.match(j9Ci, /`package-lock\.json`\/workflow/)
  assert.match(j9Ci, /精确字节/)
  assert.match(j9Ci, /独立 Node child/)
  assert.match(j9Ci, /加载 runner 与产品模块前固定 UTC/)
  assert.match(j9Ci, /产品导出继续使用 Windows 系统时区/)
})
