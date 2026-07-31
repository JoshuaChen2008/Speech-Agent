'use strict'

const base = require('./electron-builder.config.cjs')

/* Test-only package variant. It has the same ASAR/native production layout,
   but its main entry is a bounded deterministic journey. This variant is
   never the release candidate and its report says so explicitly. */

module.exports = {
  ...base,
  appId: 'com.live-subtitle.desktop.packagedsmoke',
  productName: 'Live Subtitle Packaged Smoke',
  artifactName: 'Live-Subtitle-Packaged-Smoke-${version}-${arch}.${ext}',
  directories: {
    output: '.artifacts/packaged-smoke-build'
  },
  files: [
    ...base.files,
    'scripts/product-shell-smoke.js',
    'scripts/model-ui-fixture-support.js',
    'scripts/packaged-native-load-probe.js'
  ],
  extraMetadata: {
    main: 'scripts/product-shell-smoke.js'
  },
  win: {
    ...base.win,
    executableName: 'LiveSubtitlePackagedSmoke',
    target: [{ target: 'dir', arch: ['x64'] }]
  }
}
