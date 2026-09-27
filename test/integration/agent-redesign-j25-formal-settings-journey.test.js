'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const electron = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(PROJECT_ROOT, 'scripts', 'fixtures', 'formal-agent-j25-settings-journey.js')

function waitForExit (child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('formal J25 settings journey timed out'))
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

test('SEM-F23/SEM-T04/J18/SEM-F26/SEM-F30/SEM-F31/SEM-F32/SEM-F33/SEM-F34/J21/J22/J24/J25: formal settings appearance/failure → context management → Agent Bar run/feedback/refresh → history uses one production IPC/SQLite path', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-j25-formal-settings-'))
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(userData, { recursive: true })
  const child = spawn(electron, ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer', '--in-process-gpu', FIXTURE], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      J25_FORMAL_USER_DATA: userData,
      ELECTRON_DISABLE_LOGGING: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    const result = await waitForExit(child, 75000)
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr.slice(-4000))
    const reportLine = result.stdout.trim().split(/\r?\n/).find((line) => line.startsWith('{"schemaVersion":1'))
    assert.ok(reportLine, `formal J25 report missing: ${result.stdout.slice(-1000)} ${result.stderr.slice(-4000)}`)
    const report = JSON.parse(reportLine)
    assert.equal(report.result, true, JSON.stringify(report))
    assert.equal(report.settingsPath, 'formal-settings-renderer-preload')
    assert.deepEqual(report.inputAppearance, {
      keyboardFocus: true, stableGeometry: true, themeReadable: true, controlledStates: true,
      systemPreferences: true, fits: true, specialized: true, wizardInputs: true
    })
    assert.deepEqual(report.inputsStyled, {
      textStyled: true, numberStyled: true, passwordStyled: true, selectStyled: true, textareaStyled: true
    })
    assert.equal(report.nativePicker?.attempted, true)
    assert.equal(report.nativePicker?.opened, true)
    assert.equal(report.nativePicker?.cancelValuePreserved, true)
    assert.equal(report.nativePicker?.noChangeAfterCancel, true)
    assert.equal(Number.isInteger(report.nativePicker?.changeCount), true)
    assert.equal(typeof report.nativePicker?.opened, 'boolean')
    assert.equal(report.inputFailureRecovered, true)
    assert.equal(report.uncredentialedFailureObserved, true)
    assert.equal(report.failedRevisionUnchanged, true)
    assert.equal(report.failedChangedNotBroadcast, true)
    assert.equal(report.inputPendingObserved, true)
    assert.equal(report.invalidInputFailureCode, 'MODEL_CONFIG_INVALID')
    assert.equal(report.invalidInputCommandCount, 1)
    assert.equal(report.runPath, 'formal-agent-bar-renderer-preload-main')
    assert.equal(report.historyPath, 'formal-agent-history-renderer-preload-main')
    assert.equal(report.providerRequestCount >= 2, true)
    assert.equal(report.routingMode, 'model', 'the submitted question was routed by the configured model')
    assert.equal(report.providerRequestShapes.some((shape) => shape.toolCount === 1), true, 'the selected answer model reached the provider')
    assert.equal(report.providerCredentialObserved, true)
    assert.equal(report.providerCredentialExact, true)
    assert.equal(report.modelIdentityObserved, true)
    assert.equal(report.agentEnabled, true)
    assert.equal(report.personalContextManaged, true)
    assert.equal(report.processingSuspended, true)
    assert.equal(report.processingReenabled, true)
    assert.equal(report.personalContextRevisionConflict, true)
    assert.equal(report.interactionSignalAccepted, true)
    assert.equal(report.interactionSignalReplayed, true)
    assert.equal(report.summaryCapacityFailed, true)
    assert.equal(report.summaryCapacityErrorVisible, true)
    assert.equal(report.summaryCapacityRecoveryVisible, true)
    assert.equal(report.summaryCapacityToolCalls, 0)
    assert.equal(report.summaryCapacityNoSummaryModelRequest, true)
    assert.equal(report.manualEligibilityRefresh, true)
    assert.equal(report.submitDisabledDuringEligibilityRefresh, true)
    assert.equal(report.eligibilityReadCount >= 2, true)
    assert.equal(report.feedbackSubmittedThroughRenderer, true)
    assert.equal(report.detailRereadAfterFeedback, true)
    assert.equal(report.transcriptAndPromptAbsentFromReport, true)
    assert.equal(report.publicProvider, false)
    assert.equal(report.systemCredential, false)
    assert.equal(/j25-local-provider-secret|j25-wizard-secret|请回答这场会的重点|J25 renderer feedback|受控正式设置/.test(reportLine), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
