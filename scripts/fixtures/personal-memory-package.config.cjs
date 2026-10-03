'use strict'
// Test-only ASAR variant using the production memory settings journey.
const base = require('../../electron-builder.smoke.config.cjs')
module.exports = { ...base, directories: { output: '.artifacts/memory-ui-build' },
  files: [...base.files, 'scripts/fixtures/personal-memory-electron-journey.js'],
  extraMetadata: { main: 'scripts/fixtures/personal-memory-electron-journey.js' } }
