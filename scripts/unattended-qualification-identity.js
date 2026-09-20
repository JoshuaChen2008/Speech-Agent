'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const QUALIFICATION_FILES = Object.freeze([
  'scripts/i2-live-caption-smoke.js',
  'scripts/i2-live-caption-player.html',
  'scripts/i2-live-caption-player.js',
  'scripts/i3-live-audio-soak.js',
  'scripts/i3-nonaudio-soak.js',
  'scripts/run-electron-smoke.ps1',
  'scripts/run-i2-live-series.ps1',
  'scripts/run-i3-live-audio-soak.ps1',
  'scripts/strict-evidence-json.js',
  'scripts/summarize-i2-live-series.js',
  'scripts/unattended-qualification-identity.js',
  'scripts/verify-i2-live-report.js',
  'scripts/verify-i3-live-audio-report.js',
  'scripts/verify-i3-nonaudio-report.js',
  'scripts/write-i2-exact-child-exit.js'
])

function qualificationScriptsSha256 () {
  const digest = crypto.createHash('sha256')
  for (const relative of QUALIFICATION_FILES) {
    const bytes = fs.readFileSync(path.join(ROOT, relative))
    digest.update(relative, 'utf8')
    digest.update('\0', 'utf8')
    digest.update(String(bytes.length), 'ascii')
    digest.update('\0', 'utf8')
    digest.update(bytes)
    digest.update('\0', 'utf8')
  }
  return digest.digest('hex')
}

module.exports = { QUALIFICATION_FILES, qualificationScriptsSha256 }
